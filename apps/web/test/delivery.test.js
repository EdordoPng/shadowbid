import assert from "node:assert/strict";
import test from "node:test";

import { canonicalizeDeliverableBytes, hashWorkBytes } from "@shadowbid/shared/work-capsule";
import { AVALANCHE_ESCROW_STATE, PROCUREMENT_STATUS } from "@shadowbid/shared/procurement";

import { retrieveAndVerifyDeliverable, uploadDeliverable } from "../src/deliverable.js";
import { DeliveryVerificationError, buildDeliveredContext } from "../src/delivery.js";

const RFQ_ID = `0x${"11".repeat(32)}`;
const QUOTE_ID = `0x${"22".repeat(32)}`;
const AWARD_ID = `0x${"33".repeat(32)}`;
const BUYER = "0x490b01048Af9878434727daF2C3291D2ff8a67B0";
const SELLER = "0x4A643d1340F779e5A58a5413eD8908F7e8DC519E";
const SPECIFICATION_REF = "506a357133b58499b326013bb4a5996d37bfdff0de6d2c411efa2aaa229a51cc";
const SPECIFICATION_HASH = "0xb9ae219a64126660be6d2a3494f5af2ba24d265f7665fd7d9e27d595b2e54f92";
const DELIVERABLE = Uint8Array.of(0x53, 0x68, 0x61, 0x64, 0x6f, 0x77, 0x42, 0x69, 0x64, 0x2d, 0x34, 0x45);

function baseFields(overrides = {}) {
  return {
    rfqId: RFQ_ID,
    quoteId: QUOTE_ID,
    awardId: AWARD_ID,
    buyer: BUYER,
    seller: SELLER,
    specificationRef: SPECIFICATION_REF,
    specificationHash: SPECIFICATION_HASH,
    escrowState: AVALANCHE_ESCROW_STATE.FUNDED,
    ...overrides,
  };
}

function fakeSwarmClient({ storage = new Map(), corruptRetrieval = false } = {}) {
  let counter = 0;
  return {
    async uploadData(bytes) {
      counter += 1;
      const reference = `ref-${counter}`;
      storage.set(reference, bytes);
      return { reference };
    },
    async downloadData(reference) {
      const stored = storage.get(reference);
      if (corruptRetrieval) return new TextEncoder().encode("corrupted bytes");
      return new Uint8Array(stored);
    },
    uploadCount: () => counter,
  };
}

test("builds a DELIVERED context when both byte and hash equality hold", async () => {
  const client = fakeSwarmClient();
  const uploaded = await uploadDeliverable(client, DELIVERABLE);
  const verification = await retrieveAndVerifyDeliverable(client, uploaded);
  assert.equal(verification.byteEquality, true);
  assert.equal(verification.hashEquality, true);

  const { context, status } = buildDeliveredContext({
    ...baseFields(),
    uploadedDeliverable: uploaded,
    verification,
  });

  assert.equal(context.rfqId, RFQ_ID);
  assert.equal(context.quoteId, QUOTE_ID);
  assert.equal(context.awardId, AWARD_ID);
  assert.equal(context.procurementId, AWARD_ID);
  assert.equal(context.seller, SELLER);
  assert.equal(context.specificationRef, SPECIFICATION_REF);
  assert.equal(context.specificationHash, SPECIFICATION_HASH);
  assert.equal(context.deliverableRef, uploaded.deliverableRef);
  assert.equal(context.deliverableHash, uploaded.deliverableHash);
  assert.equal(context.deliverableHash, hashWorkBytes(canonicalizeDeliverableBytes(DELIVERABLE)));
  assert.equal(context.deliverableVerified, true);
  assert.equal(context.escrowState, AVALANCHE_ESCROW_STATE.FUNDED);
  assert.equal(status, PROCUREMENT_STATUS.DELIVERED);
});

test("throws DeliveryVerificationError and builds no context on byte mismatch", async () => {
  const client = fakeSwarmClient({ corruptRetrieval: true });
  const uploaded = await uploadDeliverable(client, DELIVERABLE);
  const verification = await retrieveAndVerifyDeliverable(client, uploaded);
  assert.equal(verification.byteEquality, false);

  assert.throws(
    () => buildDeliveredContext({ ...baseFields(), uploadedDeliverable: uploaded, verification }),
    (error) => {
      assert.ok(error instanceof DeliveryVerificationError);
      assert.equal(error.byteEquality, false);
      assert.equal(error.deliverableRef, uploaded.deliverableRef);
      return true;
    },
  );
});

test("throws DeliveryVerificationError on hash mismatch even if bytes happen to compare equal", () => {
  const uploaded = Object.freeze({
    deliverableBytes: DELIVERABLE,
    deliverableHash: hashWorkBytes(DELIVERABLE),
    deliverableRef: "ref-1",
  });
  const verification = Object.freeze({
    retrievedBytes: DELIVERABLE,
    retrievedHash: `0x${"ff".repeat(32)}`,
    byteEquality: true,
    hashEquality: false,
  });

  assert.throws(
    () => buildDeliveredContext({ ...baseFields(), uploadedDeliverable: uploaded, verification }),
    DeliveryVerificationError,
  );
});

test("never derives DELIVERED status from a failed verification (escrow stays effectively FUNDED)", async () => {
  const client = fakeSwarmClient({ corruptRetrieval: true });
  const uploaded = await uploadDeliverable(client, DELIVERABLE);
  const verification = await retrieveAndVerifyDeliverable(client, uploaded);

  assert.throws(() =>
    buildDeliveredContext({ ...baseFields(), uploadedDeliverable: uploaded, verification }),
  );
  // No context/status was ever produced for a hypothetical release path to consume.
});

test("builds DELIVERED from hashEquality alone when no original bytes exist in this runtime (cross-context Buyer retrieval)", () => {
  const uploaded = Object.freeze({
    deliverableHash: hashWorkBytes(DELIVERABLE),
    deliverableRef: "ref-1",
  });
  const verification = Object.freeze({
    retrievedBytes: DELIVERABLE,
    retrievedHash: hashWorkBytes(DELIVERABLE),
    byteEquality: false,
    hashEquality: true,
  });

  const { status } = buildDeliveredContext({ ...baseFields(), uploadedDeliverable: uploaded, verification });
  assert.equal(status, PROCUREMENT_STATUS.DELIVERED);
});

test("retrying retrieval reuses the same deliverableRef/deliverableHash without a second upload", async () => {
  const client = fakeSwarmClient();
  const uploaded = await uploadDeliverable(client, DELIVERABLE);
  assert.equal(client.uploadCount(), 1);

  const firstAttempt = await retrieveAndVerifyDeliverable(client, uploaded);
  const secondAttempt = await retrieveAndVerifyDeliverable(client, uploaded);

  assert.equal(client.uploadCount(), 1);
  assert.equal(firstAttempt.hashEquality, true);
  assert.equal(secondAttempt.hashEquality, true);

  const { status } = buildDeliveredContext({
    ...baseFields(),
    uploadedDeliverable: uploaded,
    verification: secondAttempt,
  });
  assert.equal(status, PROCUREMENT_STATUS.DELIVERED);
});
