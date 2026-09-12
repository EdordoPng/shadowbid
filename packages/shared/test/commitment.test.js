import assert from "node:assert/strict";
import test from "node:test";

import { stringToBytes } from "viem";

import {
  TERMS_HASH_FIELDS,
  TERMS_HASH_VERSION,
  assertCanonicalBytes32,
  buildEscrowCommitmentInput,
  deriveTermsHash,
  hashSpecification,
  procurementIdFromAwardId,
} from "../src/commitment.js";
import { snapshotAward } from "../src/arkiv/index.js";

const RFQ_ID = `0x${"11".repeat(32)}`;
const QUOTE_ID = `0x${"22".repeat(32)}`;
const AWARD_ID = `0x${"33".repeat(32)}`;
const BUYER = "0x490b01048Af9878434727daF2C3291D2ff8a67B0";
const SELLER = "0x4A643d1340F779e5A58a5413eD8908F7e8DC519E";
const TOKEN = "0xEAAD2aaC9cdFE74F45F95C74E87b981561BcEbaC";
const DEADLINE = 1_800_003_600n;
const SPECIFICATION_HASH = hashSpecification("Review the payment contract");

function terms(overrides = {}) {
  return {
    rfqId: RFQ_ID,
    quoteId: QUOTE_ID,
    awardId: AWARD_ID,
    buyer: BUYER,
    seller: SELLER,
    token: TOKEN,
    amount: 350_000n,
    deadline: DEADLINE,
    specificationHash: SPECIFICATION_HASH,
    ...overrides,
  };
}

test("freezes procurementId as the canonical awardId, never rfqId", () => {
  assert.equal(procurementIdFromAwardId(AWARD_ID), AWARD_ID);
  assert.notEqual(procurementIdFromAwardId(AWARD_ID), RFQ_ID);
});

test("hashes specification text and raw bytes deterministically", () => {
  const text = "Review the payment contract";
  assert.equal(hashSpecification(text), hashSpecification(text));
  assert.equal(hashSpecification(text), hashSpecification(stringToBytes(text)));
  assert.notEqual(hashSpecification("0x12"), hashSpecification(Uint8Array.of(0x12)));
  assert.throws(() => hashSpecification({ text }), /string or Uint8Array/);
});

test("fixes the canonical abi.encode field order and types", () => {
  assert.equal(TERMS_HASH_VERSION, 1n);
  assert.deepEqual(TERMS_HASH_FIELDS, [
    { name: "version", type: "uint256" },
    { name: "rfqId", type: "bytes32" },
    { name: "quoteId", type: "bytes32" },
    { name: "awardId", type: "bytes32" },
    { name: "buyer", type: "address" },
    { name: "seller", type: "address" },
    { name: "token", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "deadline", type: "uint64" },
    { name: "specificationHash", type: "bytes32" },
  ]);
  assert.equal(Object.isFrozen(TERMS_HASH_FIELDS), true);
});

test("derives the same termsHash for identical inputs", () => {
  assert.equal(deriveTermsHash(terms()), deriveTermsHash(terms()));
});

test("changes termsHash when any material Award commitment field changes", () => {
  const original = deriveTermsHash(terms());
  const changes = [
    { rfqId: `0x${"44".repeat(32)}` },
    { quoteId: `0x${"55".repeat(32)}` },
    { awardId: `0x${"66".repeat(32)}` },
    { buyer: "0x0000000000000000000000000000000000000001" },
    { seller: "0x0000000000000000000000000000000000000002" },
    { token: "0x0000000000000000000000000000000000000003" },
    { amount: 350_001n },
    { deadline: DEADLINE + 1n },
    { specificationHash: `0x${"77".repeat(32)}` },
  ];

  for (const change of changes) {
    assert.notEqual(deriveTermsHash(terms(change)), original, Object.keys(change)[0]);
  }
});

test("builds exactly the immutable inputs required by escrow fund", () => {
  const award = snapshotAward({
    awardId: AWARD_ID,
    buyer: BUYER,
    deadline: DEADLINE,
    selectedQuote: {
      rfqId: RFQ_ID,
      quoteId: QUOTE_ID,
      seller: SELLER,
      price: 350_000n,
      settlementAsset: "usdc",
    },
  });

  const commitment = buildEscrowCommitmentInput({
    award,
    token: TOKEN,
    specificationHash: SPECIFICATION_HASH,
  });

  assert.deepEqual(Object.keys(commitment), [
    "procurementId",
    "seller",
    "token",
    "amount",
    "termsHash",
    "deadline",
  ]);
  assert.equal(commitment.procurementId, award.awardId);
  assert.equal(commitment.seller.toLowerCase(), award.seller.toLowerCase());
  assert.equal(commitment.amount, award.amount);
  assert.equal(commitment.deadline, award.deadline);
  assert.equal(
    commitment.termsHash,
    deriveTermsHash({ ...award, token: TOKEN, specificationHash: SPECIFICATION_HASH }),
  );
  assert.equal("buyer" in commitment, false);
  assert.equal(Object.isFrozen(commitment), true);
});

test("rejects malformed application IDs and hashes", () => {
  for (const malformed of [
    "11".repeat(32),
    `0x${"AA".repeat(32)}`,
    `0x${"11".repeat(31)}`,
    `0x${"gg".repeat(32)}`,
  ]) {
    assert.throws(() => procurementIdFromAwardId(malformed), /canonical 32-byte ID/);
    assert.throws(() => assertCanonicalBytes32(malformed), /canonical bytes32/);
  }

  assert.throws(
    () => deriveTermsHash(terms({ specificationHash: `0x${"AA".repeat(32)}` })),
    /specificationHash must be canonical bytes32/,
  );
});
