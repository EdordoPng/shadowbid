import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalizeSpecificationBytes,
  hashWorkBytes,
} from "@shadowbid/shared/work-capsule";

import {
  retrieveAndVerifySpecification,
  uploadSpecification,
} from "../src/specification.js";

test("uploads the exact byte array that was hashed", async () => {
  let uploadedBytes;
  const client = {
    async uploadData(bytes) {
      uploadedBytes = bytes;
      return { reference: "a".repeat(64) };
    },
  };

  const result = await uploadSpecification(
    client,
    "Synthetic specification\nwith exact newlines",
  );

  assert.equal(uploadedBytes, result.specificationBytes);
  assert.equal(result.specificationHash, hashWorkBytes(uploadedBytes));
  assert.deepEqual(
    result.specificationBytes,
    canonicalizeSpecificationBytes("Synthetic specification\nwith exact newlines"),
  );
});

test("verifies retrieved bytes and their recomputed hash", async () => {
  const specificationBytes = canonicalizeSpecificationBytes("Synthetic bytes");
  const uploaded = {
    specificationBytes,
    specificationHash: hashWorkBytes(specificationBytes),
    specificationRef: "b".repeat(64),
  };
  const client = {
    async downloadData(reference) {
      assert.equal(reference, uploaded.specificationRef);
      return new Uint8Array(specificationBytes);
    },
  };

  const result = await retrieveAndVerifySpecification(client, uploaded);

  assert.equal(result.byteEquality, true);
  assert.equal(result.retrievedHash, uploaded.specificationHash);
  assert.equal(result.hashEquality, true);
});

test("does not accept changed retrieved bytes as verified", async () => {
  const specificationBytes = canonicalizeSpecificationBytes("Synthetic bytes");
  const uploaded = {
    specificationBytes,
    specificationHash: hashWorkBytes(specificationBytes),
    specificationRef: "c".repeat(64),
  };
  const client = {
    async downloadData() {
      return canonicalizeSpecificationBytes("Synthetic bytes\n");
    },
  };

  const result = await retrieveAndVerifySpecification(client, uploaded);

  assert.equal(result.byteEquality, false);
  assert.equal(result.hashEquality, false);
});
