import {
  canonicalizeDeliverableBytes,
  createWorkCapsuleV1,
  hashWorkBytes,
} from "@shadowbid/shared/work-capsule";

function equalBytes(left, right) {
  if (!(left instanceof Uint8Array) || !(right instanceof Uint8Array)) return false;
  if (left.byteLength !== right.byteLength) return false;

  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }

  return true;
}

export async function uploadDeliverable(client, deliverable) {
  const deliverableBytes = canonicalizeDeliverableBytes(deliverable);
  const deliverableHash = hashWorkBytes(deliverableBytes);
  const uploaded = await client.uploadData(deliverableBytes);

  if (typeof uploaded?.reference !== "string" || uploaded.reference.length === 0) {
    throw new TypeError("Swarm upload must return a reference");
  }

  return Object.freeze({
    deliverableBytes,
    deliverableHash,
    deliverableRef: uploaded.reference,
  });
}

export async function retrieveAndVerifyDeliverable(client, uploadedDeliverable) {
  const retrievedBytes = await client.downloadData(uploadedDeliverable.deliverableRef);
  if (!(retrievedBytes instanceof Uint8Array)) {
    throw new TypeError("Swarm retrieval must return a Uint8Array");
  }

  const retrievedHash = hashWorkBytes(retrievedBytes);

  return Object.freeze({
    retrievedBytes,
    retrievedHash,
    byteEquality: equalBytes(uploadedDeliverable.deliverableBytes, retrievedBytes),
    hashEquality: retrievedHash === uploadedDeliverable.deliverableHash,
  });
}

export function buildFinalWorkCapsuleV1({
  rfqId,
  quoteId,
  awardId,
  buyer,
  seller,
  uploadedSpecification,
  uploadedDeliverable,
}) {
  return createWorkCapsuleV1({
    rfqId,
    quoteId,
    awardId,
    buyer,
    seller,
    specification: {
      ref: uploadedSpecification.specificationRef,
      hash: uploadedSpecification.specificationHash,
    },
    deliverable: {
      ref: uploadedDeliverable.deliverableRef,
      hash: uploadedDeliverable.deliverableHash,
    },
  });
}
