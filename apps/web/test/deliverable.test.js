import assert from "node:assert/strict";
import test from "node:test";

import { hashWorkBytes } from "@shadowbid/shared/work-capsule";

import {
  buildFinalWorkCapsuleV1,
  retrieveAndVerifyDeliverable,
  uploadDeliverable,
} from "../src/deliverable.js";

const RFQ_ID = `0x${"11".repeat(32)}`;
const QUOTE_ID = `0x${"22".repeat(32)}`;
const AWARD_ID = `0x${"33".repeat(32)}`;
const BUYER = "0x490b01048Af9878434727daF2C3291D2ff8a67B0";
const SELLER = "0x4A643d1340F779e5A58a5413eD8908F7e8DC519E";

test("uploads the exact deliverable byte array that was hashed", async () => {
  let uploadedBytes;
  const client = {
    async uploadData(bytes) {
      uploadedBytes = bytes;
      return { reference: "c".repeat(64) };
    },
  };

  const result = await uploadDeliverable(
    client,
    Uint8Array.of(0x53, 0x42, 0x00, 0xde, 0xad, 0xbe, 0xef),
  );

  assert.equal(uploadedBytes, result.deliverableBytes);
  assert.equal(result.deliverableHash, hashWorkBytes(uploadedBytes));
});

test("verifies retrieved deliverable bytes and their recomputed hash", async () => {
  const deliverableBytes = Uint8Array.of(0x00, 0xde, 0xad, 0xbe, 0xef);
  const uploaded = {
    deliverableBytes,
    deliverableHash: hashWorkBytes(deliverableBytes),
    deliverableRef: "d".repeat(64),
  };
  const client = {
    async downloadData(reference) {
      assert.equal(reference, uploaded.deliverableRef);
      return new Uint8Array(deliverableBytes);
    },
  };

  const result = await retrieveAndVerifyDeliverable(client, uploaded);

  assert.equal(result.byteEquality, true);
  assert.equal(result.retrievedHash, uploaded.deliverableHash);
  assert.equal(result.hashEquality, true);
});

test("does not accept changed retrieved deliverable bytes", async () => {
  const deliverableBytes = Uint8Array.of(0x01);
  const uploaded = {
    deliverableBytes,
    deliverableHash: hashWorkBytes(deliverableBytes),
    deliverableRef: "e".repeat(64),
  };
  const client = { async downloadData() { return Uint8Array.of(0x02); } };

  const result = await retrieveAndVerifyDeliverable(client, uploaded);

  assert.equal(result.byteEquality, false);
  assert.equal(result.hashEquality, false);
});

test("builds the final Work Capsule v1 without another business ID", () => {
  const specificationHash = hashWorkBytes(Uint8Array.of(0x01));
  const deliverableHash = hashWorkBytes(Uint8Array.of(0x02));
  const capsule = buildFinalWorkCapsuleV1({
    rfqId: RFQ_ID,
    quoteId: QUOTE_ID,
    awardId: AWARD_ID,
    buyer: BUYER,
    seller: SELLER,
    uploadedSpecification: {
      specificationRef: "a".repeat(64),
      specificationHash,
    },
    uploadedDeliverable: {
      deliverableRef: "b".repeat(64),
      deliverableHash,
    },
  });

  assert.deepEqual(capsule, {
    version: 1,
    rfqId: RFQ_ID,
    quoteId: QUOTE_ID,
    awardId: AWARD_ID,
    procurementId: AWARD_ID,
    buyer: BUYER,
    seller: SELLER,
    specification: { ref: "a".repeat(64), hash: specificationHash },
    deliverable: { ref: "b".repeat(64), hash: deliverableHash },
  });
  assert.equal("manifestHash" in capsule, false);
  assert.equal("deliveryId" in capsule, false);
  assert.equal("capsuleId" in capsule, false);
});
