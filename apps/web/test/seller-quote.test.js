import assert from "node:assert/strict";
import test from "node:test";

import {
  SellerQuotePublishError,
  generateQuoteId,
  publishSellerQuote,
} from "../src/seller-quote.js";

const RFQ_ID = `0x${"11".repeat(32)}`;
const QUOTE_ID = `0x${"22".repeat(32)}`;
const SELLER = "0x4A643d1340F779e5A58a5413eD8908F7e8DC519E";

function fakeArkivPublicClient({ existingEntity } = {}) {
  return {
    select() {
      return {
        where() {
          return this;
        },
        limit() {
          return this;
        },
        async fetch() {
          return { entities: existingEntity ? [existingEntity] : [] };
        },
      };
    },
  };
}

function fakeSellerArkivWriter({ fail = false, entityKey = "0xquote-entity", txHash = "0xtx" } = {}) {
  const calls = [];
  return {
    owner: SELLER,
    calls,
    async createQuote(parameters) {
      calls.push(parameters);
      if (fail) throw new Error("Arkiv write reverted");
      return { entityKey, txHash };
    },
  };
}

function baseParams(overrides = {}) {
  return {
    quoteId: QUOTE_ID,
    rfqId: RFQ_ID,
    price: 350_000n,
    etaMinutes: 20n,
    expires: { fromDays: 1 },
    ...overrides,
  };
}

test("creates a real Seller-owned Quote using the existing Arkiv writer", async () => {
  const sellerArkivWriter = fakeSellerArkivWriter();
  const arkivPublicClient = fakeArkivPublicClient();

  const result = await publishSellerQuote({
    ...baseParams(),
    sellerArkivWriter,
    arkivPublicClient,
  });

  assert.equal(sellerArkivWriter.calls.length, 1);
  assert.equal(sellerArkivWriter.calls[0].quoteId, QUOTE_ID);
  assert.equal(sellerArkivWriter.calls[0].rfqId, RFQ_ID);
  assert.equal(sellerArkivWriter.calls[0].price, 350_000n);
  assert.equal(result.quoteId, QUOTE_ID);
  assert.equal(result.seller, SELLER);
  assert.equal(result.quoteEntityKey, "0xquote-entity");
  assert.equal(result.quoteTxHash, "0xtx");
  assert.equal(result.resumedExistingQuote, false);
  assert.equal(Object.isFrozen(result), true);
});

test("resumes instead of duplicating when a Quote already exists for the same quoteId", async () => {
  const sellerArkivWriter = fakeSellerArkivWriter();
  const arkivPublicClient = fakeArkivPublicClient({
    existingEntity: { key: "0xexisting-quote", attributes: {} },
  });

  const result = await publishSellerQuote({
    ...baseParams(),
    sellerArkivWriter,
    arkivPublicClient,
  });

  assert.equal(sellerArkivWriter.calls.length, 0);
  assert.equal(result.resumedExistingQuote, true);
  assert.equal(result.quoteEntityKey, "0xexisting-quote");
});

test("wraps an Arkiv write failure in SellerQuotePublishError carrying the quoteId", async () => {
  const sellerArkivWriter = fakeSellerArkivWriter({ fail: true });
  const arkivPublicClient = fakeArkivPublicClient();

  await assert.rejects(
    publishSellerQuote({ ...baseParams(), sellerArkivWriter, arkivPublicClient }),
    (error) => {
      assert.ok(error instanceof SellerQuotePublishError);
      assert.equal(error.quoteId, QUOTE_ID);
      return true;
    },
  );
});

test("generates a fresh application quoteId per call", () => {
  const first = generateQuoteId();
  const second = generateQuoteId();

  assert.match(first, /^0x[0-9a-f]{64}$/);
  assert.notEqual(first, second);
});
