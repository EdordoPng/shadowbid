import { getAddress } from "viem";

import { assertApplicationId, assertDeadline, assertMoney } from "./arkiv/domain.js";
import { assertCanonicalBytes32, procurementIdFromAwardId } from "./commitment.js";

/**
 * Application-derived lifecycle status. This is a projection over Arkiv (market
 * facts) and Avalanche (escrow state) plus locally verified Swarm retrieval —
 * it is not a new source of truth and is never written back to any layer.
 */
export const PROCUREMENT_STATUS = Object.freeze({
  OPEN: "OPEN",
  AWARDED: "AWARDED",
  FUNDED: "FUNDED",
  DELIVERED: "DELIVERED",
  SETTLED: "SETTLED",
  // Terminal non-happy-path counterpart of the existing Slice 2 REFUNDED escrow
  // state. Not a new business concept, just its projection into app status.
  REFUNDED: "REFUNDED",
});

// Mirrors the frozen ShadowBidEscrow.State enum ordering from Slice 2. Not a
// new escrow state: a naming convenience so callers stop redefining this
// mapping ad hoc (see apps/diagnostics/shadowbid-slice-2*-live.mjs).
export const AVALANCHE_ESCROW_STATE = Object.freeze({
  NONE: 0,
  FUNDED: 1,
  RELEASED: 2,
  REFUNDED: 3,
});

const VALID_ESCROW_STATES = new Set(Object.values(AVALANCHE_ESCROW_STATE));

export class ProcurementInvariantViolation extends TypeError {
  constructor(message) {
    super(message);
    this.name = "ProcurementInvariantViolation";
  }
}

function assertBoolean(value, fieldName) {
  if (typeof value !== "boolean") {
    throw new TypeError(`${fieldName} must be a boolean`);
  }
  return value;
}

function assertEscrowState(value, fieldName) {
  if (!VALID_ESCROW_STATES.has(value)) {
    throw new TypeError(`${fieldName} must be a known AVALANCHE_ESCROW_STATE value`);
  }
  return value;
}

/**
 * Builds the minimal active-procurement projection used by the application
 * layer. Every field is optional except rfqId/buyer, reflecting that a
 * procurement starts at RFQ and gains fields as Arkiv, Swarm and Avalanche
 * facts become available. Nothing here is persisted as an authoritative
 * lifecycle store: callers re-derive this from the real sources on each read.
 */
export function createProcurementContext(input) {
  const rfqId = assertApplicationId(input.rfqId, "rfqId");
  const quoteId = input.quoteId === undefined
    ? undefined
    : assertApplicationId(input.quoteId, "quoteId");
  const awardId = input.awardId === undefined
    ? undefined
    : assertApplicationId(input.awardId, "awardId");

  let procurementId;
  if (input.procurementId !== undefined) {
    procurementId = assertApplicationId(input.procurementId, "procurementId");
    if (awardId === undefined || procurementId !== procurementIdFromAwardId(awardId)) {
      throw new ProcurementInvariantViolation("procurementId must equal awardId");
    }
  } else if (awardId !== undefined) {
    procurementId = procurementIdFromAwardId(awardId);
  }

  return Object.freeze({
    rfqId,
    quoteId,
    awardId,
    procurementId,
    buyer: getAddress(input.buyer),
    seller: input.seller === undefined ? undefined : getAddress(input.seller),
    token: input.token === undefined ? undefined : getAddress(input.token),
    amount: input.amount === undefined ? undefined : assertMoney(input.amount, "amount"),
    deadline: input.deadline === undefined ? undefined : assertDeadline(input.deadline, "deadline"),
    specificationRef: input.specificationRef,
    specificationHash: input.specificationHash === undefined
      ? undefined
      : assertCanonicalBytes32(input.specificationHash, "specificationHash"),
    deliverableRef: input.deliverableRef,
    deliverableHash: input.deliverableHash === undefined
      ? undefined
      : assertCanonicalBytes32(input.deliverableHash, "deliverableHash"),
    termsHash: input.termsHash === undefined
      ? undefined
      : assertCanonicalBytes32(input.termsHash, "termsHash"),
    fundingTxHash: input.fundingTxHash === undefined
      ? undefined
      : assertCanonicalBytes32(input.fundingTxHash, "fundingTxHash"),
    releaseTxHash: input.releaseTxHash === undefined
      ? undefined
      : assertCanonicalBytes32(input.releaseTxHash, "releaseTxHash"),
    refundTxHash: input.refundTxHash === undefined
      ? undefined
      : assertCanonicalBytes32(input.refundTxHash, "refundTxHash"),
    escrowState: input.escrowState === undefined
      ? undefined
      : assertEscrowState(input.escrowState, "escrowState"),
    specificationVerified: input.specificationVerified === undefined
      ? undefined
      : assertBoolean(input.specificationVerified, "specificationVerified"),
    deliverableVerified: input.deliverableVerified === undefined
      ? undefined
      : assertBoolean(input.deliverableVerified, "deliverableVerified"),
  });
}

/**
 * Pure status derivation. Delivery is never read from Avalanche: it only
 * exists once a Swarm retrieval has been verified byte-for-byte, on top of a
 * FUNDED escrow. Settlement is read straight from the authoritative Avalanche
 * escrow state, never inferred.
 */
export function deriveProcurementStatus(context) {
  if (context.escrowState === AVALANCHE_ESCROW_STATE.RELEASED) {
    return PROCUREMENT_STATUS.SETTLED;
  }
  if (context.escrowState === AVALANCHE_ESCROW_STATE.REFUNDED) {
    return PROCUREMENT_STATUS.REFUNDED;
  }
  if (context.escrowState === AVALANCHE_ESCROW_STATE.FUNDED) {
    return context.deliverableVerified === true
      ? PROCUREMENT_STATUS.DELIVERED
      : PROCUREMENT_STATUS.FUNDED;
  }
  return context.awardId !== undefined ? PROCUREMENT_STATUS.AWARDED : PROCUREMENT_STATUS.OPEN;
}

/** procurementId must equal awardId (Slice 1 + Slice 2 frozen rule). */
export function assertProcurementIdMatchesAwardId(procurementId, awardId) {
  if (procurementIdFromAwardId(awardId) !== assertApplicationId(procurementId, "procurementId")) {
    throw new ProcurementInvariantViolation("procurementId must equal awardId");
  }
}

/** The Award actually references the RFQ (and its Buyer) the caller expects. */
export function assertAwardMatchesRfq(award, rfq) {
  if (award.rfqId !== rfq.rfqId) {
    throw new ProcurementInvariantViolation("Award rfqId does not match the current RFQ");
  }
  if (rfq.buyer !== undefined && getAddress(award.buyer) !== getAddress(rfq.buyer)) {
    throw new ProcurementInvariantViolation("Award buyer does not match the RFQ buyer");
  }
}

/** The Award actually reflects the selected Quote (seller + amount). */
export function assertAwardMatchesQuote(award, selectedQuote) {
  if (award.quoteId !== selectedQuote.quoteId) {
    throw new ProcurementInvariantViolation("Award quoteId does not match the selected Quote");
  }
  if (getAddress(award.seller) !== getAddress(selectedQuote.seller)) {
    throw new ProcurementInvariantViolation(
      "Award seller does not match the selected Quote seller",
    );
  }
  if (award.amount !== selectedQuote.price) {
    throw new ProcurementInvariantViolation(
      "Award amount does not match the selected Quote price",
    );
  }
}

/** specificationHash must exist before an escrow funding commitment is built. */
export function assertSpecificationHashBeforeFunding(context) {
  if (context.specificationHash === undefined) {
    throw new ProcurementInvariantViolation("specificationHash is required before funding");
  }
}

/** A verified (byte-equal + hash-equal) deliverable retrieval must precede release. */
export function assertVerifiedDeliveryBeforeRelease(context) {
  if (context.deliverableVerified !== true) {
    throw new ProcurementInvariantViolation(
      "A verified deliverable retrieval is required before release",
    );
  }
}

// --- Pure retry/idempotency decision predicates (Slice 4B+ wire these to live reads) ---

/** NONE is the only escrow state that may still be funded. */
export function canFund(escrowState) {
  return escrowState === AVALANCHE_ESCROW_STATE.NONE;
}

/** Already FUNDED with the same termsHash means the prior fund() attempt succeeded: resume. */
export function isFundedWithMatchingTerms(escrowState, storedTermsHash, expectedTermsHash) {
  return escrowState === AVALANCHE_ESCROW_STATE.FUNDED && storedTermsHash === expectedTermsHash;
}

/** Only a FUNDED escrow may be released; RELEASED/REFUNDED are terminal. */
export function canRelease(escrowState) {
  return escrowState === AVALANCHE_ESCROW_STATE.FUNDED;
}

/** Only a FUNDED escrow past its deadline may be refunded; the contract is the final authority. */
export function canRefund(escrowState, deadlineSeconds, nowSeconds) {
  return escrowState === AVALANCHE_ESCROW_STATE.FUNDED && nowSeconds >= deadlineSeconds;
}
