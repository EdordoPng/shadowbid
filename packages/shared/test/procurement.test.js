import assert from "node:assert/strict";
import test from "node:test";

import {
  AVALANCHE_ESCROW_STATE,
  PROCUREMENT_STATUS,
  ProcurementInvariantViolation,
  assertAwardMatchesQuote,
  assertAwardMatchesRfq,
  assertProcurementIdMatchesAwardId,
  assertSpecificationHashBeforeFunding,
  assertVerifiedDeliveryBeforeRelease,
  canFund,
  canRefund,
  canRelease,
  createProcurementContext,
  deriveProcurementStatus,
  isFundedWithMatchingTerms,
} from "../src/procurement.js";

const RFQ_ID = `0x${"11".repeat(32)}`;
const QUOTE_ID = `0x${"22".repeat(32)}`;
const AWARD_ID = `0x${"33".repeat(32)}`;
const OTHER_ID = `0x${"44".repeat(32)}`;
const BUYER = "0x490b01048Af9878434727daF2C3291D2ff8a67B0";
const SELLER = "0x4A643d1340F779e5A58a5413eD8908F7e8DC519E";
const TOKEN = "0xEAAD2aaC9cdFE74F45F95C74E87b981561BcEbaC";
const SPEC_HASH = `0x${"55".repeat(32)}`;
const DELIVERABLE_HASH = `0x${"66".repeat(32)}`;
const TERMS_HASH = `0x${"77".repeat(32)}`;

test("creates a minimal OPEN-stage context with only rfqId and buyer", () => {
  const context = createProcurementContext({ rfqId: RFQ_ID, buyer: BUYER });

  assert.equal(context.rfqId, RFQ_ID);
  assert.equal(context.buyer, BUYER);
  assert.equal(context.awardId, undefined);
  assert.equal(context.procurementId, undefined);
  assert.equal(Object.isFrozen(context), true);
  assert.equal(deriveProcurementStatus(context), PROCUREMENT_STATUS.OPEN);
});

test("derives procurementId from awardId and freezes the context", () => {
  const context = createProcurementContext({
    rfqId: RFQ_ID,
    quoteId: QUOTE_ID,
    awardId: AWARD_ID,
    buyer: BUYER,
    seller: SELLER,
  });

  assert.equal(context.procurementId, AWARD_ID);
  assert.equal(deriveProcurementStatus(context), PROCUREMENT_STATUS.AWARDED);
});

test("rejects an explicit procurementId that differs from awardId", () => {
  assert.throws(
    () =>
      createProcurementContext({
        rfqId: RFQ_ID,
        awardId: AWARD_ID,
        procurementId: OTHER_ID,
        buyer: BUYER,
      }),
    ProcurementInvariantViolation,
  );
});

test("rejects a procurementId supplied without an awardId", () => {
  assert.throws(
    () =>
      createProcurementContext({
        rfqId: RFQ_ID,
        procurementId: AWARD_ID,
        buyer: BUYER,
      }),
    ProcurementInvariantViolation,
  );
});

test("derives status across the full happy path plus the refunded terminal state", () => {
  const base = { rfqId: RFQ_ID, awardId: AWARD_ID, buyer: BUYER, seller: SELLER };

  assert.equal(
    deriveProcurementStatus(createProcurementContext(base)),
    PROCUREMENT_STATUS.AWARDED,
  );
  assert.equal(
    deriveProcurementStatus(
      createProcurementContext({ ...base, escrowState: AVALANCHE_ESCROW_STATE.FUNDED }),
    ),
    PROCUREMENT_STATUS.FUNDED,
  );
  assert.equal(
    deriveProcurementStatus(
      createProcurementContext({
        ...base,
        escrowState: AVALANCHE_ESCROW_STATE.FUNDED,
        deliverableVerified: true,
      }),
    ),
    PROCUREMENT_STATUS.DELIVERED,
  );
  assert.equal(
    deriveProcurementStatus(
      createProcurementContext({ ...base, escrowState: AVALANCHE_ESCROW_STATE.RELEASED }),
    ),
    PROCUREMENT_STATUS.SETTLED,
  );
  assert.equal(
    deriveProcurementStatus(
      createProcurementContext({ ...base, escrowState: AVALANCHE_ESCROW_STATE.REFUNDED }),
    ),
    PROCUREMENT_STATUS.REFUNDED,
  );
});

test("never derives DELIVERED without an explicitly verified deliverable retrieval", () => {
  const context = createProcurementContext({
    rfqId: RFQ_ID,
    awardId: AWARD_ID,
    buyer: BUYER,
    seller: SELLER,
    escrowState: AVALANCHE_ESCROW_STATE.FUNDED,
    deliverableRef: "some-ref-without-verification",
  });

  assert.equal(deriveProcurementStatus(context), PROCUREMENT_STATUS.FUNDED);
});

test("assertProcurementIdMatchesAwardId enforces the frozen Slice 1/2 rule", () => {
  assert.doesNotThrow(() => assertProcurementIdMatchesAwardId(AWARD_ID, AWARD_ID));
  assert.throws(
    () => assertProcurementIdMatchesAwardId(OTHER_ID, AWARD_ID),
    ProcurementInvariantViolation,
  );
});

test("assertAwardMatchesRfq guards rfqId and buyer linkage", () => {
  const award = { rfqId: RFQ_ID, buyer: BUYER };

  assert.doesNotThrow(() => assertAwardMatchesRfq(award, { rfqId: RFQ_ID, buyer: BUYER }));
  assert.throws(
    () => assertAwardMatchesRfq(award, { rfqId: OTHER_ID, buyer: BUYER }),
    ProcurementInvariantViolation,
  );
  assert.throws(
    () => assertAwardMatchesRfq(award, { rfqId: RFQ_ID, buyer: SELLER }),
    ProcurementInvariantViolation,
  );
});

test("assertAwardMatchesQuote guards quoteId, seller and amount linkage", () => {
  const award = { quoteId: QUOTE_ID, seller: SELLER, amount: 350_000n };
  const quote = { quoteId: QUOTE_ID, seller: SELLER, price: 350_000n };

  assert.doesNotThrow(() => assertAwardMatchesQuote(award, quote));
  assert.throws(
    () => assertAwardMatchesQuote(award, { ...quote, quoteId: OTHER_ID }),
    ProcurementInvariantViolation,
  );
  assert.throws(
    () => assertAwardMatchesQuote(award, { ...quote, seller: BUYER }),
    ProcurementInvariantViolation,
  );
  assert.throws(
    () => assertAwardMatchesQuote(award, { ...quote, price: 1n }),
    ProcurementInvariantViolation,
  );
});

test("specificationHash is required before funding", () => {
  const withoutSpec = createProcurementContext({ rfqId: RFQ_ID, awardId: AWARD_ID, buyer: BUYER });
  const withSpec = createProcurementContext({
    rfqId: RFQ_ID,
    awardId: AWARD_ID,
    buyer: BUYER,
    specificationHash: SPEC_HASH,
  });

  assert.throws(
    () => assertSpecificationHashBeforeFunding(withoutSpec),
    ProcurementInvariantViolation,
  );
  assert.doesNotThrow(() => assertSpecificationHashBeforeFunding(withSpec));
});

test("a verified deliverable retrieval is required before release", () => {
  const unverified = createProcurementContext({
    rfqId: RFQ_ID,
    awardId: AWARD_ID,
    buyer: BUYER,
    deliverableHash: DELIVERABLE_HASH,
    deliverableVerified: false,
  });
  const verified = createProcurementContext({
    rfqId: RFQ_ID,
    awardId: AWARD_ID,
    buyer: BUYER,
    deliverableHash: DELIVERABLE_HASH,
    deliverableVerified: true,
  });

  assert.throws(
    () => assertVerifiedDeliveryBeforeRelease(unverified),
    ProcurementInvariantViolation,
  );
  assert.doesNotThrow(() => assertVerifiedDeliveryBeforeRelease(verified));
});

test("fund/release decision predicates match the frozen escrow state machine", () => {
  assert.equal(canFund(AVALANCHE_ESCROW_STATE.NONE), true);
  assert.equal(canFund(AVALANCHE_ESCROW_STATE.FUNDED), false);

  assert.equal(isFundedWithMatchingTerms(AVALANCHE_ESCROW_STATE.FUNDED, TERMS_HASH, TERMS_HASH), true);
  assert.equal(
    isFundedWithMatchingTerms(AVALANCHE_ESCROW_STATE.FUNDED, TERMS_HASH, OTHER_ID),
    false,
  );
  assert.equal(
    isFundedWithMatchingTerms(AVALANCHE_ESCROW_STATE.NONE, TERMS_HASH, TERMS_HASH),
    false,
  );

  assert.equal(canRelease(AVALANCHE_ESCROW_STATE.FUNDED), true);
  assert.equal(canRelease(AVALANCHE_ESCROW_STATE.RELEASED), false);
  assert.equal(canRelease(AVALANCHE_ESCROW_STATE.REFUNDED), false);
  assert.equal(canRelease(AVALANCHE_ESCROW_STATE.NONE), false);
});

test("canRefund is true only for a FUNDED escrow at or past its deadline", () => {
  const DEADLINE = 1_800_000_000;

  assert.equal(canRefund(AVALANCHE_ESCROW_STATE.FUNDED, DEADLINE, DEADLINE - 1), false);
  assert.equal(canRefund(AVALANCHE_ESCROW_STATE.FUNDED, DEADLINE, DEADLINE), true);
  assert.equal(canRefund(AVALANCHE_ESCROW_STATE.FUNDED, DEADLINE, DEADLINE + 1), true);

  assert.equal(canRefund(AVALANCHE_ESCROW_STATE.NONE, DEADLINE, DEADLINE + 1), false);
  assert.equal(canRefund(AVALANCHE_ESCROW_STATE.RELEASED, DEADLINE, DEADLINE + 1), false);
  assert.equal(canRefund(AVALANCHE_ESCROW_STATE.REFUNDED, DEADLINE, DEADLINE + 1), false);
});

test("rejects a malformed escrowState value", () => {
  assert.throws(
    () =>
      createProcurementContext({
        rfqId: RFQ_ID,
        buyer: BUYER,
        escrowState: 99,
      }),
    /AVALANCHE_ESCROW_STATE/,
  );
});

test("carries funding-time fields (token, amount, deadline, termsHash) through unchanged", () => {
  const context = createProcurementContext({
    rfqId: RFQ_ID,
    awardId: AWARD_ID,
    buyer: BUYER,
    seller: SELLER,
    token: TOKEN,
    amount: 350_000n,
    deadline: 1_800_003_600n,
    termsHash: TERMS_HASH,
  });

  assert.equal(context.token, TOKEN);
  assert.equal(context.amount, 350_000n);
  assert.equal(context.termsHash, TERMS_HASH);
});
