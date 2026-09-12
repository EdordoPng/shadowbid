import { createProcurementContext, deriveProcurementStatus } from "@shadowbid/shared/procurement";

/** A fresh, non-sensitive text fixture for the Slice 4E live proof — distinct
 * from the Slice 3B/3C fixtures so the resulting ref/hash are unambiguous. */
export const SYNTHETIC_DELIVERABLE_4E = new TextEncoder().encode(
  "ShadowBid Slice 4E deliverable v1\nSecurity review report placeholder.",
);

/**
 * Thrown when a retrieved deliverable fails integrity verification (byte
 * mismatch and/or hash mismatch). No ProcurementContext is ever built when
 * this is thrown: DELIVERED can never be derived from a failed check.
 */
export class DeliveryVerificationError extends Error {
  constructor(message, { deliverableRef, deliverableHash, byteEquality, hashEquality }) {
    super(message);
    this.name = "DeliveryVerificationError";
    this.deliverableRef = deliverableRef;
    this.deliverableHash = deliverableHash;
    this.byteEquality = byteEquality;
    this.hashEquality = hashEquality;
  }
}

/**
 * Joins a verified Swarm deliverable retrieval (Slice 3's
 * retrieveAndVerifyDeliverable, unchanged) with the real Award/RFQ
 * identifiers into a ProcurementContext (Slice 4A, unchanged).
 *
 * Callers drive the actual Swarm calls themselves with the existing
 * uploadDeliverable/retrieveAndVerifyDeliverable from ./deliverable.js — this
 * function only ever consumes their results, so a retry after a failed
 * retrieval naturally reuses the same uploadedDeliverable (deliverableRef/
 * deliverableHash) without a second upload.
 *
 * The canonical integrity gate is hashEquality: keccak256 of the exact
 * retrieved Swarm bytes against deliverableHash. byteEquality (a raw
 * comparison against uploadedDeliverable.deliverableBytes) is diagnostic
 * only — it is meaningful when the original bytes genuinely exist in the
 * same runtime (e.g. the Seller's own upload-time self-check), but a Buyer
 * verifying from a different session never has them, and none are cached
 * or manufactured to produce one. Throws DeliveryVerificationError instead
 * of returning a context when hashEquality did not hold — a mismatch can
 * never produce DELIVERED, and no context exists afterwards for any release
 * path to use.
 */
export function buildDeliveredContext({
  rfqId,
  quoteId,
  awardId,
  buyer,
  seller,
  specificationRef,
  specificationHash,
  escrowState,
  uploadedDeliverable,
  verification,
}) {
  if (verification.hashEquality !== true) {
    throw new DeliveryVerificationError("Deliverable retrieval failed integrity verification", {
      deliverableRef: uploadedDeliverable.deliverableRef,
      deliverableHash: uploadedDeliverable.deliverableHash,
      byteEquality: verification.byteEquality,
      hashEquality: verification.hashEquality,
    });
  }

  const context = createProcurementContext({
    rfqId,
    quoteId,
    awardId,
    buyer,
    seller,
    specificationRef,
    specificationHash,
    deliverableRef: uploadedDeliverable.deliverableRef,
    deliverableHash: uploadedDeliverable.deliverableHash,
    deliverableVerified: true,
    escrowState,
  });

  return Object.freeze({ context, status: deriveProcurementStatus(context) });
}
