import {
  canonicalizeSpecificationBytes,
  hashWorkBytes,
} from "@shadowbid/shared/work-capsule";

export const SYNTHETIC_SPECIFICATION =
  "Synthetic ShadowBid specification for Slice 3B.\nScope: demo contract only.";

function equalBytes(left, right) {
  if (!(left instanceof Uint8Array) || !(right instanceof Uint8Array)) return false;
  if (left.byteLength !== right.byteLength) return false;

  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }

  return true;
}

export async function uploadSpecification(client, specification) {
  const specificationBytes = canonicalizeSpecificationBytes(specification);
  const specificationHash = hashWorkBytes(specificationBytes);
  const uploaded = await client.uploadData(specificationBytes);

  if (typeof uploaded?.reference !== "string" || uploaded.reference.length === 0) {
    throw new TypeError("Swarm upload must return a reference");
  }

  return Object.freeze({
    specificationBytes,
    specificationHash,
    specificationRef: uploaded.reference,
  });
}

export async function retrieveAndVerifySpecification(client, uploadedSpecification) {
  const retrievedBytes = await client.downloadData(
    uploadedSpecification.specificationRef,
  );
  if (!(retrievedBytes instanceof Uint8Array)) {
    throw new TypeError("Swarm retrieval must return a Uint8Array");
  }

  const retrievedHash = hashWorkBytes(retrievedBytes);

  return Object.freeze({
    retrievedBytes,
    retrievedHash,
    byteEquality: equalBytes(
      uploadedSpecification.specificationBytes,
      retrievedBytes,
    ),
    hashEquality: retrievedHash === uploadedSpecification.specificationHash,
  });
}
