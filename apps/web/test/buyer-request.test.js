import assert from "node:assert/strict";
import test from "node:test";

import { canonicalizeSpecificationBytes, hashWorkBytes } from "@shadowbid/shared/work-capsule";

import {
  BuyerRequestPublishError,
  generateRfqId,
  publishBuyerRequest,
  readBackBuyerRequest,
} from "../src/buyer-request.js";

const RFQ_ID = `0x${"11".repeat(32)}`;
const BUYER = "0x490b01048Af9878434727daF2C3291D2ff8a67B0";
const SPECIFICATION = "Synthetic ShadowBid Slice 4B specification\nExact bytes only.";

function fakeSwarmClient({ reference = "a".repeat(64), fail = false } = {}) {
  const calls = [];
  return {
    calls,
    async uploadData(bytes) {
      calls.push(bytes);
      if (fail) throw new Error("Swarm gateway unavailable");
      return { reference };
    },
  };
}

function fakeArkivPublicClient({ existingEntity } = {}) {
  return {
    select() {
      return {
        where() {
          return this;
        },
        limit() {
          return this;
        },
        async fetch() {
          return { entities: existingEntity ? [existingEntity] : [] };
        },
      };
    },
  };
}

function fakeBuyerArkivWriter({ fail = false, entityKey = "0xentity", txHash = "0xtx" } = {}) {
  const calls = [];
  return {
    owner: BUYER,
    calls,
    async createRfq(parameters) {
      calls.push(parameters);
      if (fail) throw new Error("Arkiv write reverted");
      return { entityKey, txHash };
    },
  };
}

function baseParams(overrides = {}) {
  return {
    rfqId: RFQ_ID,
    specification: SPECIFICATION,
    title: "Review the payment contract",
    maxBudget: 500_000n,
    maxEtaMinutes: 60n,
    expires: { fromDays: 1 },
    ...overrides,
  };
}

test("uploads to Swarm once, then creates the Buyer-owned RFQ", async () => {
  const swarmClient = fakeSwarmClient();
  const buyerArkivWriter = fakeBuyerArkivWriter();
  const arkivPublicClient = fakeArkivPublicClient();

  const result = await publishBuyerRequest({
    ...baseParams(),
    swarmClient,
    buyerArkivWriter,
    arkivPublicClient,
  });

  assert.equal(swarmClient.calls.length, 1);
  assert.equal(buyerArkivWriter.calls.length, 1);
  assert.equal(buyerArkivWriter.calls[0].rfqId, RFQ_ID);
  assert.equal("specification" in buyerArkivWriter.calls[0], false);
  assert.equal(
    buyerArkivWriter.calls[0].specificationHash,
    hashWorkBytes(canonicalizeSpecificationBytes(SPECIFICATION)),
  );
  assert.equal(typeof buyerArkivWriter.calls[0].specificationRef, "string");
  assert.equal(result.rfqId, RFQ_ID);
  assert.equal(result.buyer, BUYER);
  assert.equal(result.resumedExistingRfq, false);
  assert.equal(result.rfqEntityKey, "0xentity");
  assert.equal(result.rfqTxHash, "0xtx");
  assert.equal(
    result.specificationHash,
    hashWorkBytes(canonicalizeSpecificationBytes(SPECIFICATION)),
  );
  assert.equal(result.context.rfqId, RFQ_ID);
  assert.equal(result.context.specificationHash, result.specificationHash);
  assert.equal(Object.isFrozen(result), true);
});

test("stops before creating an RFQ when the Swarm upload fails", async () => {
  const swarmClient = fakeSwarmClient({ fail: true });
  const buyerArkivWriter = fakeBuyerArkivWriter();
  const arkivPublicClient = fakeArkivPublicClient();

  await assert.rejects(
    publishBuyerRequest({
      ...baseParams(),
      swarmClient,
      buyerArkivWriter,
      arkivPublicClient,
    }),
    (error) => {
      assert.ok(error instanceof BuyerRequestPublishError);
      assert.equal(error.rfqId, RFQ_ID);
      assert.equal(error.specificationRef, undefined);
      assert.equal(error.specificationHash, undefined);
      return true;
    },
  );
  assert.equal(buyerArkivWriter.calls.length, 0);
});

test("preserves specificationRef/specificationHash for retry when the Arkiv write fails", async () => {
  const swarmClient = fakeSwarmClient();
  const failingWriter = fakeBuyerArkivWriter({ fail: true });
  const arkivPublicClient = fakeArkivPublicClient();

  let caught;
  try {
    await publishBuyerRequest({
      ...baseParams(),
      swarmClient,
      buyerArkivWriter: failingWriter,
      arkivPublicClient,
    });
    assert.fail("expected publishBuyerRequest to reject");
  } catch (error) {
    caught = error;
  }

  assert.ok(caught instanceof BuyerRequestPublishError);
  assert.equal(caught.rfqId, RFQ_ID);
  assert.equal(
    caught.specificationHash,
    hashWorkBytes(canonicalizeSpecificationBytes(SPECIFICATION)),
  );
  assert.equal(typeof caught.specificationRef, "string");
  assert.equal(swarmClient.calls.length, 1);

  // Retry: reuse the preserved ref/hash, never touch Swarm again.
  const swarmClientThatMustNotBeCalled = fakeSwarmClient({ fail: true });
  const succeedingWriter = fakeBuyerArkivWriter();
  const retried = await publishBuyerRequest({
    ...baseParams(),
    rfqId: caught.rfqId,
    specificationRef: caught.specificationRef,
    specificationHash: caught.specificationHash,
    specification: undefined,
    swarmClient: swarmClientThatMustNotBeCalled,
    buyerArkivWriter: succeedingWriter,
    arkivPublicClient,
  });

  assert.equal(swarmClientThatMustNotBeCalled.calls.length, 0);
  assert.equal(succeedingWriter.calls.length, 1);
  assert.equal(retried.specificationHash, caught.specificationHash);
  assert.equal(retried.specificationRef, caught.specificationRef);
  assert.equal(retried.resumedExistingRfq, false);
});

test("resumes instead of creating a duplicate RFQ when one already exists for the same rfqId", async () => {
  const swarmClient = fakeSwarmClient();
  const buyerArkivWriter = fakeBuyerArkivWriter();
  const arkivPublicClient = fakeArkivPublicClient({
    existingEntity: { key: "0xexisting-entity", attributes: {} },
  });

  const result = await publishBuyerRequest({
    ...baseParams(),
    swarmClient,
    buyerArkivWriter,
    arkivPublicClient,
  });

  assert.equal(buyerArkivWriter.calls.length, 0);
  assert.equal(result.resumedExistingRfq, true);
  assert.equal(result.rfqEntityKey, "0xexisting-entity");
});

test("independently rereads the specification linkage from the RFQ payload, not the in-memory context", async () => {
  const specificationRef = "b".repeat(64);
  const specificationHash = `0x${"77".repeat(32)}`;
  const entity = {
    key: "0xentity",
    attributes: {
      rfq_id: { value: RFQ_ID },
      buyer: { value: BUYER },
      status: { value: "open" },
      max_budget: { value: 500_000n },
      max_eta_minutes: { value: 60n },
    },
    toJson: () => ({ title: "Review the payment contract", specificationRef, specificationHash }),
  };
  const arkivPublicClient = fakeArkivPublicClient({ existingEntity: entity });

  const readBack = await readBackBuyerRequest({ arkivPublicClient, rfqId: RFQ_ID });

  assert.equal(readBack.rfqId, RFQ_ID);
  assert.equal(readBack.rfqEntityKey, "0xentity");
  assert.equal(readBack.buyer, BUYER);
  assert.equal(readBack.status, "open");
  assert.equal(readBack.maxBudget, 500_000n);
  assert.equal(readBack.maxEtaMinutes, 60n);
  assert.equal(readBack.specificationRef, specificationRef);
  assert.equal(readBack.specificationHash, specificationHash);
});

test("readBackBuyerRequest returns undefined when no RFQ exists for that rfqId", async () => {
  const arkivPublicClient = fakeArkivPublicClient();

  assert.equal(await readBackBuyerRequest({ arkivPublicClient, rfqId: RFQ_ID }), undefined);
});

test("generates a fresh application rfqId per call and accepts a caller-supplied one for retries", () => {
  const first = generateRfqId();
  const second = generateRfqId();

  assert.match(first, /^0x[0-9a-f]{64}$/);
  assert.notEqual(first, second);
});
