import assert from "node:assert/strict";
import test from "node:test";

import { bytesToHex } from "viem";

import { deriveTermsHash } from "../src/commitment.js";
import {
  WORK_CAPSULE_VERSION,
  canonicalizeDeliverableBytes,
  canonicalizeSpecificationBytes,
  createWorkCapsuleV1,
  hashWorkBytes,
} from "../src/work-capsule.js";

const RFQ_ID = `0x${"11".repeat(32)}`;
const QUOTE_ID = `0x${"22".repeat(32)}`;
const AWARD_ID = `0x${"33".repeat(32)}`;
const BUYER = "0x490b01048Af9878434727daF2C3291D2ff8a67B0";
const SELLER = "0x4A643d1340F779e5A58a5413eD8908F7e8DC519E";
const TOKEN = "0xEAAD2aaC9cdFE74F45F95C74E87b981561BcEbaC";

test("canonicalizes specification text to its exact UTF-8 bytes once", () => {
  const text = "A\n€";
  const bytes = canonicalizeSpecificationBytes(text);

  assert.ok(bytes instanceof Uint8Array);
  assert.equal(bytesToHex(bytes), "0x410ae282ac");
  assert.notDeepEqual(
    canonicalizeSpecificationBytes("A"),
    canonicalizeSpecificationBytes("A\n"),
  );
  assert.throws(
    () => canonicalizeSpecificationBytes(Uint8Array.of(0x41)),
    /must be a string/,
  );
});

test("hashes identical bytes identically and different bytes differently", () => {
  const first = canonicalizeDeliverableBytes(Uint8Array.of(0x00, 0x41, 0xff));
  const same = canonicalizeDeliverableBytes(Uint8Array.of(0x00, 0x41, 0xff));
  const different = canonicalizeDeliverableBytes(Uint8Array.of(0x00, 0x41, 0xfe));

  assert.equal(hashWorkBytes(first), hashWorkBytes(same));
  assert.notEqual(hashWorkBytes(first), hashWorkBytes(different));
  assert.notEqual(
    hashWorkBytes(canonicalizeSpecificationBytes("A")),
    hashWorkBytes(canonicalizeSpecificationBytes("A\n")),
  );
  assert.throws(() => hashWorkBytes("A"), /must be a Uint8Array/);
});

test("builds the minimal immutable Work Capsule v1 and derives procurementId", () => {
  const specificationHash = hashWorkBytes(
    canonicalizeSpecificationBytes("Synthetic specification"),
  );
  const deliverableHash = hashWorkBytes(
    canonicalizeDeliverableBytes(Uint8Array.of(0xde, 0xad, 0xbe, 0xef)),
  );
  const capsule = createWorkCapsuleV1({
    rfqId: RFQ_ID,
    quoteId: QUOTE_ID,
    awardId: AWARD_ID,
    buyer: BUYER,
    seller: SELLER,
    specification: { ref: "a".repeat(64), hash: specificationHash },
    deliverable: { ref: "b".repeat(64), hash: deliverableHash },
  });

  assert.deepEqual(capsule, {
    version: WORK_CAPSULE_VERSION,
    rfqId: RFQ_ID,
    quoteId: QUOTE_ID,
    awardId: AWARD_ID,
    procurementId: AWARD_ID,
    buyer: BUYER,
    seller: SELLER,
    specification: { ref: "a".repeat(64), hash: specificationHash },
    deliverable: { ref: "b".repeat(64), hash: deliverableHash },
  });
  assert.equal(WORK_CAPSULE_VERSION, 1);
  assert.equal(Object.isFrozen(capsule), true);
  assert.equal(Object.isFrozen(capsule.specification), true);
  assert.equal(Object.isFrozen(capsule.deliverable), true);
  assert.equal("manifestHash" in capsule, false);
  assert.equal("capsuleId" in capsule, false);
});

test("rejects a procurementId that differs from awardId", () => {
  const hash = hashWorkBytes(Uint8Array.of(0x01));

  assert.throws(
    () =>
      createWorkCapsuleV1({
        rfqId: RFQ_ID,
        quoteId: QUOTE_ID,
        awardId: AWARD_ID,
        procurementId: `0x${"44".repeat(32)}`,
        buyer: BUYER,
        seller: SELLER,
        specification: { ref: "a".repeat(64), hash },
        deliverable: { ref: "b".repeat(64), hash },
      }),
    /procurementId must equal awardId/,
  );
});

test("passes the new specification hash directly into Slice 2 termsHash", () => {
  const specificationBytes = canonicalizeSpecificationBytes("Synthetic terms input");
  const specificationHash = hashWorkBytes(specificationBytes);
  const input = {
    rfqId: RFQ_ID,
    quoteId: QUOTE_ID,
    awardId: AWARD_ID,
    buyer: BUYER,
    seller: SELLER,
    token: TOKEN,
    amount: 350_000n,
    deadline: 1_800_003_600n,
    specificationHash,
  };

  assert.match(specificationHash, /^0x[0-9a-f]{64}$/);
  assert.equal(deriveTermsHash(input), deriveTermsHash({ ...input }));
});
