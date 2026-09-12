import { getAddress, keccak256, stringToBytes } from "viem";

import { assertApplicationId } from "./arkiv/domain.js";
import { assertCanonicalBytes32 } from "./commitment.js";

export const WORK_CAPSULE_VERSION = 1;

export function canonicalizeSpecificationBytes(specification) {
  if (typeof specification !== "string") {
    throw new TypeError("specification must be a string");
  }

  return stringToBytes(specification);
}

export function canonicalizeDeliverableBytes(deliverable) {
  if (!(deliverable instanceof Uint8Array)) {
    throw new TypeError("deliverable must be a Uint8Array");
  }

  return new Uint8Array(deliverable);
}

export function hashWorkBytes(bytes) {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError("bytes must be a Uint8Array");
  }

  return keccak256(bytes);
}

function snapshotWorkReference(value, fieldName) {
  if (typeof value !== "object" || value === null) {
    throw new TypeError(`${fieldName} must contain ref and hash`);
  }
  if (typeof value.ref !== "string" || value.ref.length === 0) {
    throw new TypeError(`${fieldName}.ref must be a non-empty string`);
  }

  return Object.freeze({
    ref: value.ref,
    hash: assertCanonicalBytes32(value.hash, `${fieldName}.hash`),
  });
}

export function createWorkCapsuleV1({
  rfqId,
  quoteId,
  awardId,
  procurementId,
  buyer,
  seller,
  specification,
  deliverable,
}) {
  const canonicalAwardId = assertApplicationId(awardId, "awardId");

  if (
    procurementId !== undefined &&
    assertApplicationId(procurementId, "procurementId") !== canonicalAwardId
  ) {
    throw new TypeError("procurementId must equal awardId");
  }

  return Object.freeze({
    version: WORK_CAPSULE_VERSION,
    rfqId: assertApplicationId(rfqId, "rfqId"),
    quoteId: assertApplicationId(quoteId, "quoteId"),
    awardId: canonicalAwardId,
    procurementId: canonicalAwardId,
    buyer: getAddress(buyer),
    seller: getAddress(seller),
    specification: snapshotWorkReference(specification, "specification"),
    deliverable: snapshotWorkReference(deliverable, "deliverable"),
  });
}
