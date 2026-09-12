import assert from "node:assert/strict";
import test from "node:test";

import { ProcurementInvariantViolation } from "@shadowbid/shared/procurement";

import {
  AwardCreationError,
  QuoteNoLongerEligibleError,
  createBuyerAward,
  generateAwardId,
} from "../src/buyer-award.js";

const RFQ_ID = `0x${"11".repeat(32)}`;
const QUOTE_A_ID = `0x${"22".repeat(32)}`;
const QUOTE_B_ID = `0x${"44".repeat(32)}`;
const AWARD_ID = `0x${"33".repeat(32)}`;
const BUYER = "0x490b01048Af9878434727daF2C3291D2ff8a67B0";
const SELLER_A = "0x4A643d1340F779e5A58a5413eD8908F7e8DC519E";
const SPECIFICATION_REF = "506a357133b58499b326013bb4a5996d37bfdff0de6d2c411efa2aaa229a51cc";
const SPECIFICATION_HASH = "0xb9ae219a64126660be6d2a3494f5af2ba24d265f7665fd7d9e27d595b2e54f92";
const DEADLINE = 1_900_000_000n;

function value(v) {
  return { value: v };
}

function rfqEntity() {
  return {
    key: "0xrfq-entity",
    attributes: {
      rfq_id: value(RFQ_ID),
      buyer: value(BUYER),
      status: value("open"),
      max_budget: value(500_000n),
      max_eta_minutes: value(60n),
    },
    toJson: () => ({
      title: "ShadowBid Slice 4B live Buyer Request",
      specificationRef: SPECIFICATION_REF,
      specificationHash: SPECIFICATION_HASH,
    }),
  };
}

function openQuoteEntity({ quoteId = QUOTE_A_ID, seller = SELLER_A, price = 350_000n } = {}) {
  return {
    key: `0xquote-entity-${quoteId.slice(-4)}`,
    attributes: {
      entity_type: value("quote"),
      quote_id: value(quoteId),
      rfq_id: value(RFQ_ID),
      seller: value(seller),
      price: value(price),
      eta_minutes: value(20n),
      settlement_asset: value("usdc"),
      status: value("open"),
    },
  };
}

function entityTypeOf(predicate) {
  return predicate.expressions.find((expression) => expression.name === "entity_type").value
    .value;
}

function fakeArkivPublicClient({ rfq = rfqEntity(), openQuotes = [], existingAward } = {}) {
  return {
    select() {
      let capturedPredicate;
      return {
        where(predicate) {
          capturedPredicate = predicate;
          return this;
        },
        limit() {
          return this;
        },
        async fetch() {
          const type = entityTypeOf(capturedPredicate);
          if (type === "rfq") return { entities: rfq ? [rfq] : [] };
          if (type === "quote") return { entities: openQuotes };
          if (type === "award") return { entities: existingAward ? [existingAward] : [] };
          return { entities: [] };
        },
      };
    },
  };
}

function fakeBuyerArkivWriter({ fail = false, entityKey = "0xaward-entity", txHash = "0xtx" } = {}) {
  const calls = [];
  return {
    owner: BUYER,
    calls,
    async createAward(parameters) {
      calls.push(parameters);
      if (fail) throw new Error("Arkiv write reverted");
      return { entityKey, txHash };
    },
  };
}

function baseParams(overrides = {}) {
  return {
    awardId: AWARD_ID,
    rfqId: RFQ_ID,
    selectedQuoteId: QUOTE_A_ID,
    deadline: DEADLINE,
    expires: { fromDays: 1 },
    ...overrides,
  };
}

test("creates a real Buyer-owned Award from a still-eligible selected Quote", async () => {
  const buyerArkivWriter = fakeBuyerArkivWriter();
  const arkivPublicClient = fakeArkivPublicClient({
    openQuotes: [openQuoteEntity(), openQuoteEntity({ quoteId: QUOTE_B_ID, price: 250_000n })],
  });

  const result = await createBuyerAward({
    ...baseParams(),
    buyerArkivWriter,
    arkivPublicClient,
  });

  assert.equal(buyerArkivWriter.calls.length, 1);
  assert.equal(buyerArkivWriter.calls[0].awardId, AWARD_ID);
  assert.equal(buyerArkivWriter.calls[0].selectedQuote.quoteId, QUOTE_A_ID);
  assert.equal(buyerArkivWriter.calls[0].selectedQuote.seller, SELLER_A);
  assert.equal(buyerArkivWriter.calls[0].selectedQuote.price, 350_000n);
  assert.equal(result.rfqId, RFQ_ID);
  assert.equal(result.quoteId, QUOTE_A_ID);
  assert.equal(result.awardId, AWARD_ID);
  assert.equal(result.procurementId, AWARD_ID);
  assert.equal(result.buyer, BUYER);
  assert.equal(result.seller, SELLER_A);
  assert.equal(result.amount, 350_000n);
  assert.equal(result.settlementAsset, "usdc");
  assert.equal(result.deadline, DEADLINE);
  assert.equal(result.resumedExistingAward, false);
  assert.equal(result.specificationRef, SPECIFICATION_REF);
  assert.equal(result.specificationHash, SPECIFICATION_HASH);
  assert.equal(result.context.rfqId, RFQ_ID);
  assert.equal(result.context.quoteId, QUOTE_A_ID);
  assert.equal(result.context.awardId, AWARD_ID);
  assert.equal(result.context.procurementId, AWARD_ID);
  assert.equal(result.context.specificationHash, SPECIFICATION_HASH);
  assert.equal(Object.isFrozen(result), true);
});

test("stops with QUOTE_NO_LONGER_ELIGIBLE and never writes an Award for an expired/absent Quote", async () => {
  const buyerArkivWriter = fakeBuyerArkivWriter();
  const arkivPublicClient = fakeArkivPublicClient({
    // Selected Quote A is no longer returned by the canonical eligibility query.
    openQuotes: [openQuoteEntity({ quoteId: QUOTE_B_ID, price: 250_000n })],
  });

  await assert.rejects(
    createBuyerAward({ ...baseParams(), buyerArkivWriter, arkivPublicClient }),
    (error) => {
      assert.ok(error instanceof QuoteNoLongerEligibleError);
      assert.equal(error.code, "QUOTE_NO_LONGER_ELIGIBLE");
      assert.equal(error.quoteId, QUOTE_A_ID);
      return true;
    },
  );
  assert.equal(buyerArkivWriter.calls.length, 0);
});

test("resumes instead of duplicating when a matching Award already exists for the same awardId", async () => {
  const buyerArkivWriter = fakeBuyerArkivWriter();
  const arkivPublicClient = fakeArkivPublicClient({
    openQuotes: [openQuoteEntity()],
    existingAward: {
      key: "0xexisting-award",
      attributes: {
        entity_type: value("award"),
        rfq_id: value(RFQ_ID),
        quote_id: value(QUOTE_A_ID),
        buyer: value(BUYER),
        seller: value(SELLER_A),
        amount: value(350_000n),
      },
    },
  });

  const result = await createBuyerAward({ ...baseParams(), buyerArkivWriter, arkivPublicClient });

  assert.equal(buyerArkivWriter.calls.length, 0);
  assert.equal(result.resumedExistingAward, true);
  assert.equal(result.awardEntityKey, "0xexisting-award");
});

test("stops as a conflict when an existing Award for the same awardId does not match the intended Quote", async () => {
  const buyerArkivWriter = fakeBuyerArkivWriter();
  const arkivPublicClient = fakeArkivPublicClient({
    openQuotes: [openQuoteEntity()],
    existingAward: {
      key: "0xconflicting-award",
      attributes: {
        entity_type: value("award"),
        rfq_id: value(RFQ_ID),
        quote_id: value(QUOTE_B_ID),
        buyer: value(BUYER),
        seller: value(SELLER_A),
        amount: value(250_000n),
      },
    },
  });

  await assert.rejects(
    createBuyerAward({ ...baseParams(), buyerArkivWriter, arkivPublicClient }),
    ProcurementInvariantViolation,
  );
  assert.equal(buyerArkivWriter.calls.length, 0);
});

test("wraps an Arkiv Award write failure in AwardCreationError carrying the awardId", async () => {
  const buyerArkivWriter = fakeBuyerArkivWriter({ fail: true });
  const arkivPublicClient = fakeArkivPublicClient({ openQuotes: [openQuoteEntity()] });

  await assert.rejects(
    createBuyerAward({ ...baseParams(), buyerArkivWriter, arkivPublicClient }),
    (error) => {
      assert.ok(error instanceof AwardCreationError);
      assert.equal(error.awardId, AWARD_ID);
      return true;
    },
  );
});

test("generates a fresh application awardId per call", () => {
  const first = generateAwardId();
  const second = generateAwardId();

  assert.match(first, /^0x[0-9a-f]{64}$/);
  assert.notEqual(first, second);
});
