import assert from "node:assert/strict";
import test from "node:test";

import { ExpirationTime } from "@arkiv-network/sdk";
import { addr } from "@arkiv-network/sdk/attr";

import {
  assertApplicationId,
  assertDeadline,
  assertMoney,
  buildAwardByIdPredicate,
  buildAwardCreateParameters,
  buildActiveQuotesByRfqPredicate,
  buildOpenQuotePredicate,
  buildQuoteByIdPredicate,
  buildQuoteCreateParameters,
  buildRfqByIdPredicate,
  buildRfqCreateParameters,
  createBuyerArkivWriter,
  createActiveQuotesByRfqQuery,
  createOpenQuoteQuery,
  createSellerArkivWriter,
  mapAwardAttributes,
  mapQuoteAttributes,
  mapRfqAttributes,
  queryAwardById,
  queryActiveQuotesByRfq,
  queryOpenQuotes,
  queryQuoteById,
  queryRfqById,
  readRfqPayload,
  snapshotSelectedQuote,
  snapshotAward,
} from "../src/arkiv/index.js";

const SPECIFICATION_REF = "a".repeat(64);
const SPECIFICATION_HASH = `0x${"66".repeat(32)}`;

const RFQ_ID = `0x${"11".repeat(32)}`;
const QUOTE_ID = `0x${"22".repeat(32)}`;
const AWARD_ID = `0x${"33".repeat(32)}`;
const BUYER = "0x490b01048Af9878434727daF2C3291D2ff8a67B0";
const SELLER = "0x4A643d1340F779e5A58a5413eD8908F7e8DC519E";
const OTHER = "0xEAAD2aaC9cdFE74F45F95C74E87b981561BcEbaC";
const CREATED_AT = 1_800_000_000n;
const DEADLINE = 1_800_003_600n;

function value(type, storedValue) {
  return { type, value: storedValue };
}

function selectedQuote(overrides = {}) {
  return {
    quoteId: QUOTE_ID,
    rfqId: RFQ_ID,
    seller: SELLER,
    price: 350_000n,
    settlementAsset: "usdc",
    ...overrides,
  };
}

test("maps the complete RFQ schema and keeps title as the only payload field when no specification is linked yet", () => {
  const expires = ExpirationTime.fromDays(1);
  const input = {
    rfqId: RFQ_ID,
    buyer: BUYER,
    maxBudget: 500_000n,
    maxEtaMinutes: 60n,
    createdAt: CREATED_AT,
    title: "Review payment contract",
    expires,
  };

  assert.deepEqual(mapRfqAttributes(input), {
    entity_type: value("str", "rfq"),
    rfq_id: value("bytes32", RFQ_ID),
    buyer: value("addr", addr(BUYER).value),
    service_type: value("str", "security_review"),
    max_budget: value("u256", 500_000n),
    max_eta_minutes: value("u64", 60n),
    settlement_asset: value("str", "usdc"),
    status: value("str", "open"),
    created_at: value("u64", CREATED_AT),
  });

  const parameters = buildRfqCreateParameters(input);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(parameters.payload)), {
    title: input.title,
  });
  assert.equal(parameters.contentType, "application/json");
  assert.equal(parameters.expires, expires);
  assert.equal("procurement_id" in parameters.attributes, false);
});

test("carries specificationRef/specificationHash in the RFQ payload only, never as query attributes", () => {
  const input = {
    rfqId: RFQ_ID,
    buyer: BUYER,
    maxBudget: 500_000n,
    maxEtaMinutes: 60n,
    createdAt: CREATED_AT,
    title: "Review payment contract",
    expires: ExpirationTime.fromDays(1),
    specificationRef: SPECIFICATION_REF,
    specificationHash: SPECIFICATION_HASH,
  };

  const parameters = buildRfqCreateParameters(input);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(parameters.payload)), {
    title: input.title,
    specificationRef: SPECIFICATION_REF,
    specificationHash: SPECIFICATION_HASH,
  });
  assert.equal("specification_ref" in parameters.attributes, false);
  assert.equal("specification_hash" in parameters.attributes, false);
  assert.deepEqual(mapRfqAttributes(input), mapRfqAttributes({ ...input, specificationRef: undefined, specificationHash: undefined }));
});

test("rejects a specificationRef/specificationHash pair that isn't provided together", () => {
  const input = {
    rfqId: RFQ_ID,
    buyer: BUYER,
    maxBudget: 500_000n,
    maxEtaMinutes: 60n,
    createdAt: CREATED_AT,
    title: "Review payment contract",
    expires: ExpirationTime.fromDays(1),
  };

  assert.throws(
    () => buildRfqCreateParameters({ ...input, specificationRef: SPECIFICATION_REF }),
    /must be provided together/,
  );
  assert.throws(
    () => buildRfqCreateParameters({ ...input, specificationHash: SPECIFICATION_HASH }),
    /must be provided together/,
  );
  assert.throws(
    () => buildRfqCreateParameters({ ...input, specificationRef: "", specificationHash: SPECIFICATION_HASH }),
    /specificationRef must be a non-empty string/,
  );
  assert.throws(
    () =>
      buildRfqCreateParameters({
        ...input,
        specificationRef: SPECIFICATION_REF,
        specificationHash: `0x${"AA".repeat(32)}`,
      }),
    /specificationHash must be a canonical 32-byte ID/,
  );
});

test("reads the RFQ payload back symmetrically, without needing the original publish result", () => {
  const parameters = buildRfqCreateParameters({
    rfqId: RFQ_ID,
    buyer: BUYER,
    maxBudget: 500_000n,
    maxEtaMinutes: 60n,
    createdAt: CREATED_AT,
    title: "Review payment contract",
    expires: ExpirationTime.fromDays(1),
    specificationRef: SPECIFICATION_REF,
    specificationHash: SPECIFICATION_HASH,
  });
  const rereadEntity = {
    toJson: () => JSON.parse(new TextDecoder().decode(parameters.payload)),
  };

  assert.deepEqual(readRfqPayload(rereadEntity), {
    title: "Review payment contract",
    specificationRef: SPECIFICATION_REF,
    specificationHash: SPECIFICATION_HASH,
  });
});

test("maps the complete Quote schema and passes Arkiv-native expiry through unchanged", () => {
  const expires = ExpirationTime.fromMinutes(30);
  const input = {
    quoteId: QUOTE_ID,
    rfqId: RFQ_ID,
    seller: SELLER,
    price: 350_000n,
    etaMinutes: 45n,
    createdAt: CREATED_AT,
    expires,
  };

  assert.deepEqual(mapQuoteAttributes(input), {
    entity_type: value("str", "quote"),
    quote_id: value("bytes32", QUOTE_ID),
    rfq_id: value("bytes32", RFQ_ID),
    seller: value("addr", addr(SELLER).value),
    service_type: value("str", "security_review"),
    price: value("u256", 350_000n),
    eta_minutes: value("u64", 45n),
    settlement_asset: value("str", "usdc"),
    status: value("str", "open"),
    created_at: value("u64", CREATED_AT),
  });

  const parameters = buildQuoteCreateParameters(input);
  assert.equal(parameters.expires, expires);
  assert.equal(parameters.payload.byteLength, 0);
  assert.equal("expires_at" in parameters.attributes, false);
});

test("maps Award fields without placeholder hashes", () => {
  const attributes = mapAwardAttributes({
    awardId: AWARD_ID,
    buyer: BUYER,
    selectedQuote: selectedQuote(),
    deadline: DEADLINE,
    createdAt: CREATED_AT,
  });

  assert.deepEqual(attributes, {
    entity_type: value("str", "award"),
    award_id: value("bytes32", AWARD_ID),
    rfq_id: value("bytes32", RFQ_ID),
    quote_id: value("bytes32", QUOTE_ID),
    buyer: value("addr", addr(BUYER).value),
    seller: value("addr", addr(SELLER).value),
    amount: value("u256", 350_000n),
    settlement_asset: value("str", "usdc"),
    status: value("str", "pending_funding"),
    deadline: value("u64", DEADLINE),
    created_at: value("u64", CREATED_AT),
  });
  assert.equal("terms_hash" in attributes, false);
  assert.equal("escrow_tx_hash" in attributes, false);
});

test("accepts only canonical lowercase 32-byte application IDs", () => {
  assert.equal(assertApplicationId(RFQ_ID), RFQ_ID);

  for (const invalid of [
    "11".repeat(32),
    `0x${"11".repeat(31)}`,
    `0x${"11".repeat(33)}`,
    `0x${"AA".repeat(32)}`,
    `0x${"gg".repeat(32)}`,
  ]) {
    assert.throws(() => assertApplicationId(invalid), /canonical 32-byte ID/);
  }
});

test("validates Award deadlines as positive uint64 Unix timestamps", () => {
  assert.equal(assertDeadline(DEADLINE), DEADLINE);

  for (const invalid of [0n, -1n, 1, "1800003600", 2n ** 64n]) {
    assert.throws(() => assertDeadline(invalid), /deadline|u64/i);
  }
});

test("represents money only as non-negative bigint token base units", () => {
  assert.equal(assertMoney(500_000n), 500_000n);
  assert.equal(mapQuoteAttributes({
    quoteId: QUOTE_ID,
    rfqId: RFQ_ID,
    seller: SELLER,
    price: 250_000n,
    etaMinutes: 30n,
    createdAt: CREATED_AT,
  }).price.value, 250_000n);

  for (const invalid of [0.5, 500_000, "500000", -1n]) {
    assert.throws(() => assertMoney(invalid), /token base units/);
  }
});

test("builds all seven typed predicates in the canonical compound query", () => {
  const predicate = buildOpenQuotePredicate({
    rfqId: RFQ_ID,
    budget: 500_000n,
    maxEtaMinutes: 60n,
  });

  assert.equal(predicate.kind, "and");
  assert.deepEqual(
    predicate.expressions.map(({ name, operator, value: typedValue }) => ({
      name,
      operator,
      type: typedValue.type,
      value: typedValue.value,
    })),
    [
      { name: "entity_type", operator: "=", type: "str", value: "quote" },
      { name: "rfq_id", operator: "=", type: "bytes32", value: RFQ_ID },
      { name: "service_type", operator: "=", type: "str", value: "security_review" },
      { name: "price", operator: "<=", type: "u256", value: 500_000n },
      { name: "eta_minutes", operator: "<=", type: "u64", value: 60n },
      { name: "settlement_asset", operator: "=", type: "str", value: "usdc" },
      { name: "status", operator: "=", type: "str", value: "open" },
    ],
  );
  assert.equal(
    String(predicate),
    `entity_type = str('quote') AND rfq_id = bytes32(${RFQ_ID}) AND ` +
      `service_type = str('security_review') AND price <= u256(500000) AND ` +
      `eta_minutes <= u64(60) AND settlement_asset = str('usdc') AND status = str('open')`,
  );
});

test("executes the canonical predicate through Arkiv's query builder without JS filtering", async () => {
  const page = Object.freeze({ entities: [], blockNumber: 123n });
  const calls = [];
  const builder = {
    where(predicate) {
      calls.push(["where", predicate]);
      return this;
    },
    limit(limit) {
      calls.push(["limit", limit]);
      return this;
    },
    async fetch() {
      calls.push(["fetch"]);
      return page;
    },
  };
  const publicClient = {
    select(selection) {
      calls.push(["select", selection]);
      return builder;
    },
  };
  const criteria = { rfqId: RFQ_ID, budget: 500_000n, maxEtaMinutes: 60n };

  assert.equal(createOpenQuoteQuery(publicClient, criteria), builder);
  calls.length = 0;
  assert.equal(await queryOpenQuotes(publicClient, criteria), page);
  assert.deepEqual(calls.map(([method]) => method), ["select", "where", "limit", "fetch"]);
  assert.equal(String(calls[1][1]), String(buildOpenQuotePredicate(criteria)));
});

test("builds and executes the active Quote count query at the RFQ snapshot block", async () => {
  const predicate = buildActiveQuotesByRfqPredicate({ rfqId: RFQ_ID });
  assert.equal(
    String(predicate),
    `entity_type = str('quote') AND rfq_id = bytes32(${RFQ_ID}) AND status = str('open')`,
  );

  const page = Object.freeze({ entities: [], blockNumber: 123n });
  const calls = [];
  const builder = {
    where(value) { calls.push(["where", value]); return this; },
    limit(value) { calls.push(["limit", value]); return this; },
    atBlock(value) { calls.push(["atBlock", value]); return this; },
    async fetch() { calls.push(["fetch"]); return page; },
  };
  const publicClient = {
    select(selection) { calls.push(["select", selection]); return builder; },
  };

  assert.equal(
    createActiveQuotesByRfqQuery(publicClient, { rfqId: RFQ_ID }, { atBlock: 123n }),
    builder,
  );
  assert.deepEqual(calls.map(([method]) => method), ["select", "where", "limit", "atBlock"]);
  calls.length = 0;
  assert.equal(
    await queryActiveQuotesByRfq(publicClient, { rfqId: RFQ_ID }, { atBlock: 123n }),
    page,
  );
  assert.deepEqual(calls.map(([method]) => method), ["select", "where", "limit", "atBlock", "fetch"]);
});

test("builds the RFQ-by-id predicate reused to detect an already-published RFQ", () => {
  const predicate = buildRfqByIdPredicate({ rfqId: RFQ_ID });

  assert.equal(predicate.kind, "and");
  assert.deepEqual(
    predicate.expressions.map(({ name, operator, value: typedValue }) => ({
      name,
      operator,
      type: typedValue.type,
      value: typedValue.value,
    })),
    [
      { name: "entity_type", operator: "=", type: "str", value: "rfq" },
      { name: "rfq_id", operator: "=", type: "bytes32", value: RFQ_ID },
    ],
  );
});

test("queries an RFQ by id through Arkiv's query builder without JS filtering", async () => {
  const page = Object.freeze({ entities: [{ key: "0xentity", attributes: {} }] });
  const calls = [];
  const builder = {
    where(predicate) {
      calls.push(["where", predicate]);
      return this;
    },
    limit(limit) {
      calls.push(["limit", limit]);
      return this;
    },
    async fetch() {
      calls.push(["fetch"]);
      return page;
    },
  };
  const publicClient = {
    select(selection) {
      calls.push(["select", selection]);
      return builder;
    },
  };

  assert.equal(await queryRfqById(publicClient, { rfqId: RFQ_ID }), page);
  assert.deepEqual(calls.map(([method]) => method), ["select", "where", "limit", "fetch"]);
  assert.deepEqual(calls[2], ["limit", 1]);
});

test("builds the Quote-by-id predicate reused to detect an already-published Quote", () => {
  const predicate = buildQuoteByIdPredicate({ quoteId: QUOTE_ID });

  assert.equal(predicate.kind, "and");
  assert.deepEqual(
    predicate.expressions.map(({ name, operator, value: typedValue }) => ({
      name,
      operator,
      type: typedValue.type,
      value: typedValue.value,
    })),
    [
      { name: "entity_type", operator: "=", type: "str", value: "quote" },
      { name: "quote_id", operator: "=", type: "bytes32", value: QUOTE_ID },
    ],
  );
});

test("queries a Quote by id through Arkiv's query builder without JS filtering", async () => {
  const page = Object.freeze({ entities: [{ key: "0xquote-entity", attributes: {} }] });
  const calls = [];
  const builder = {
    where(predicate) {
      calls.push(["where", predicate]);
      return this;
    },
    limit(limit) {
      calls.push(["limit", limit]);
      return this;
    },
    async fetch() {
      calls.push(["fetch"]);
      return page;
    },
  };
  const publicClient = {
    select(selection) {
      calls.push(["select", selection]);
      return builder;
    },
  };

  assert.equal(await queryQuoteById(publicClient, { quoteId: QUOTE_ID }), page);
  assert.deepEqual(calls.map(([method]) => method), ["select", "where", "limit", "fetch"]);
  assert.deepEqual(calls[2], ["limit", 1]);
});

test("builds the Award-by-id predicate reused to detect an already-created Award", () => {
  const predicate = buildAwardByIdPredicate({ awardId: AWARD_ID });

  assert.equal(predicate.kind, "and");
  assert.deepEqual(
    predicate.expressions.map(({ name, operator, value: typedValue }) => ({
      name,
      operator,
      type: typedValue.type,
      value: typedValue.value,
    })),
    [
      { name: "entity_type", operator: "=", type: "str", value: "award" },
      { name: "award_id", operator: "=", type: "bytes32", value: AWARD_ID },
    ],
  );
});

test("queries an Award by id through Arkiv's query builder without JS filtering", async () => {
  const page = Object.freeze({ entities: [] });
  const calls = [];
  const builder = {
    where(predicate) {
      calls.push(["where", predicate]);
      return this;
    },
    limit(limit) {
      calls.push(["limit", limit]);
      return this;
    },
    async fetch() {
      calls.push(["fetch"]);
      return page;
    },
  };
  const publicClient = {
    select(selection) {
      calls.push(["select", selection]);
      return builder;
    },
  };

  assert.equal(await queryAwardById(publicClient, { awardId: AWARD_ID }), page);
  assert.deepEqual(calls.map(([method]) => method), ["select", "where", "limit", "fetch"]);
  assert.deepEqual(calls[2], ["limit", 1]);
});

test("freezes Award commercial fields from the selected Quote", () => {
  const quote = selectedQuote();
  const parameters = buildAwardCreateParameters({
    awardId: AWARD_ID,
    buyer: BUYER,
    selectedQuote: quote,
    deadline: DEADLINE,
    createdAt: CREATED_AT,
    expires: ExpirationTime.fromDays(7),
  });

  quote.price = 1n;
  quote.seller = OTHER;

  assert.equal(parameters.attributes.rfq_id.value, RFQ_ID);
  assert.equal(parameters.attributes.quote_id.value, QUOTE_ID);
  assert.equal(parameters.attributes.seller.value, addr(SELLER).value);
  assert.equal(parameters.attributes.amount.value, 350_000n);
  assert.equal(parameters.attributes.settlement_asset.value, "usdc");
  assert.equal(parameters.attributes.deadline.value, DEADLINE);

  const award = snapshotAward({
    awardId: AWARD_ID,
    buyer: BUYER,
    selectedQuote: selectedQuote(),
    deadline: DEADLINE,
  });
  assert.equal(Object.isFrozen(award), true);
  assert.equal(award.deadline, DEADLINE);
  assert.throws(() => {
    award.deadline = DEADLINE + 1n;
  }, TypeError);

  const snapshot = snapshotSelectedQuote(selectedQuote());
  assert.equal(Object.isFrozen(snapshot), true);
  assert.throws(() => {
    snapshot.price = 1n;
  }, TypeError);

  const conflicts = {
    rfqId: `0x${"44".repeat(32)}`,
    quoteId: `0x${"55".repeat(32)}`,
    seller: OTHER,
    amount: 1n,
    settlementAsset: "dai",
  };
  for (const [fieldName, conflictingValue] of Object.entries(conflicts)) {
    assert.throws(
      () =>
        buildAwardCreateParameters({
          awardId: AWARD_ID,
          buyer: BUYER,
          selectedQuote: selectedQuote(),
          deadline: DEADLINE,
          createdAt: CREATED_AT,
          expires: ExpirationTime.fromDays(7),
          [fieldName]: conflictingValue,
        }),
      new RegExp(`${fieldName} must match the selected Quote`),
    );
  }
});

test("separates Buyer and Seller write capabilities and verifies signer ownership", async () => {
  const buyerCalls = [];
  const sellerCalls = [];
  const buyerWallet = {
    account: { address: BUYER },
    async createEntity(parameters) {
      buyerCalls.push(parameters);
      return { entityKey: RFQ_ID };
    },
  };
  const sellerWallet = {
    account: { address: SELLER },
    async createEntity(parameters) {
      sellerCalls.push(parameters);
      return { entityKey: QUOTE_ID };
    },
  };
  const buyerWriter = createBuyerArkivWriter({ walletClient: buyerWallet, buyer: BUYER });
  const sellerWriter = createSellerArkivWriter({ walletClient: sellerWallet, seller: SELLER });

  assert.equal(typeof buyerWriter.createRfq, "function");
  assert.equal(typeof buyerWriter.createAward, "function");
  assert.equal(buyerWriter.createQuote, undefined);
  assert.equal(typeof sellerWriter.createQuote, "function");
  assert.equal(sellerWriter.createRfq, undefined);
  assert.equal(sellerWriter.createAward, undefined);

  const expires = ExpirationTime.fromDays(1);
  await buyerWriter.createRfq({
    rfqId: RFQ_ID,
    maxBudget: 500_000n,
    maxEtaMinutes: 60n,
    createdAt: CREATED_AT,
    title: "Review payment contract",
    expires,
  });
  await sellerWriter.createQuote({
    quoteId: QUOTE_ID,
    rfqId: RFQ_ID,
    price: 350_000n,
    etaMinutes: 45n,
    createdAt: CREATED_AT,
    expires,
  });
  await buyerWriter.createAward({
    awardId: AWARD_ID,
    selectedQuote: selectedQuote(),
    deadline: DEADLINE,
    createdAt: CREATED_AT,
    expires,
  });

  assert.equal(buyerCalls.length, 2);
  assert.equal(sellerCalls.length, 1);
  assert.equal(buyerCalls[0].attributes.buyer.value, addr(BUYER).value);
  assert.equal(sellerCalls[0].attributes.seller.value, addr(SELLER).value);
  assert.equal(buyerCalls[1].attributes.seller.value, addr(SELLER).value);

  assert.throws(
    () => createBuyerArkivWriter({ walletClient: sellerWallet, buyer: BUYER }),
    /signer does not match/,
  );
  assert.throws(
    () => createSellerArkivWriter({ walletClient: buyerWallet, seller: SELLER }),
    /signer does not match/,
  );
});
