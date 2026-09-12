import assert from "node:assert/strict";
import test from "node:test";

import { deriveTermsHash } from "@shadowbid/shared/commitment";
import {
  AVALANCHE_ESCROW_STATE,
  PROCUREMENT_STATUS,
  ProcurementInvariantViolation,
  createProcurementContext,
} from "@shadowbid/shared/procurement";

import { EscrowTermsHashMismatchError } from "../src/fund-award.js";
import {
  EscrowReleaseConflictError,
  ReleaseError,
  releaseAward,
} from "../src/release-award.js";

const RFQ_ID = `0x${"11".repeat(32)}`;
const QUOTE_ID = `0x${"22".repeat(32)}`;
const AWARD_ID = `0x${"33".repeat(32)}`;
const BUYER = "0x490b01048Af9878434727daF2C3291D2ff8a67B0";
const SELLER = "0x4A643d1340F779e5A58a5413eD8908F7e8DC519E";
const TOKEN = "0xEAAD2aaC9cdFE74F45F95C74E87b981561BcEbaC";
const ESCROW_ADDRESS = "0xB8d8ba69db07B957C4ce97220BF8b88E558D0738";
const SPECIFICATION_REF = "506a357133b58499b326013bb4a5996d37bfdff0de6d2c411efa2aaa229a51cc";
const SPECIFICATION_HASH = "0xb9ae219a64126660be6d2a3494f5af2ba24d265f7665fd7d9e27d595b2e54f92";
const DELIVERABLE_REF = "f65382703c3d55453fd9377a4523b708ac8ed3d0eb10e07fe6fd96df2ed616b9";
const DELIVERABLE_HASH = "0x78557756608ec8ac1f9be9d0d9e03448b1e3259f6c6d95bd23158ae0baad743e";
const DEADLINE = 1_900_000_000n;
const AMOUNT = 350_000n;

const COMMITMENT = Object.freeze({
  procurementId: AWARD_ID,
  seller: SELLER,
  token: TOKEN,
  amount: AMOUNT,
  termsHash: deriveTermsHash({
    rfqId: RFQ_ID,
    quoteId: QUOTE_ID,
    awardId: AWARD_ID,
    buyer: BUYER,
    seller: SELLER,
    token: TOKEN,
    amount: AMOUNT,
    deadline: DEADLINE,
    specificationHash: SPECIFICATION_HASH,
  }),
  deadline: DEADLINE,
});

function deliveredContext(overrides = {}) {
  return createProcurementContext({
    rfqId: RFQ_ID,
    quoteId: QUOTE_ID,
    awardId: AWARD_ID,
    buyer: BUYER,
    seller: SELLER,
    specificationRef: SPECIFICATION_REF,
    specificationHash: SPECIFICATION_HASH,
    deliverableRef: DELIVERABLE_REF,
    deliverableHash: DELIVERABLE_HASH,
    deliverableVerified: true,
    escrowState: AVALANCHE_ESCROW_STATE.FUNDED,
    ...overrides,
  });
}

function fakeClients({ escrowState, storedTermsHash = COMMITMENT.termsHash, sellerBalance = 0n } = {}) {
  const calls = { read: [], simulate: [], write: [] };
  let currentEscrow = { state: escrowState, termsHash: storedTermsHash };
  let currentSellerBalance = sellerBalance;

  const publicClient = {
    async readContract({ functionName, args }) {
      calls.read.push(functionName);
      if (functionName === "getEscrow") return currentEscrow;
      if (functionName === "balanceOf") {
        assert.equal(args[0], SELLER);
        return currentSellerBalance;
      }
      throw new Error(`unexpected read ${functionName}`);
    },
    async simulateContract({ functionName, args }) {
      calls.simulate.push(functionName);
      return { request: { functionName, args } };
    },
    async waitForTransactionReceipt() {
      return { status: "success", blockNumber: 1n };
    },
  };

  const walletClient = {
    account: { address: BUYER },
    async writeContract(request) {
      calls.write.push(request.functionName);
      if (request.functionName === "release") {
        currentEscrow = { state: AVALANCHE_ESCROW_STATE.RELEASED, termsHash: storedTermsHash };
        currentSellerBalance += AMOUNT;
        return "0xreleasetx";
      }
      return "0xtx";
    },
  };

  return { publicClient, walletClient, calls };
}

function baseArgs(overrides = {}) {
  return {
    escrowAddress: ESCROW_ADDRESS,
    escrowAbi: [],
    usdcAddress: TOKEN,
    usdcAbi: [],
    commitment: COMMITMENT,
    context: deliveredContext(),
    ...overrides,
  };
}

test("releases a FUNDED escrow: Seller receives exactly the Award amount and status becomes SETTLED", async () => {
  const { publicClient, walletClient, calls } = fakeClients({
    escrowState: AVALANCHE_ESCROW_STATE.FUNDED,
    sellerBalance: 10_000_000n,
  });

  const result = await releaseAward({ publicClient, walletClient, ...baseArgs() });

  assert.equal(calls.write.length, 1);
  assert.equal(calls.write[0], "release");
  assert.equal(result.resumedAlreadyReleased, false);
  assert.equal(result.releaseTxHash, "0xreleasetx");
  assert.equal(result.sellerBalanceBefore, 10_000_000n);
  assert.equal(result.sellerBalanceAfter, 10_000_000n + AMOUNT);
  assert.equal(result.balanceDelta, AMOUNT);
  assert.equal(result.escrowState, AVALANCHE_ESCROW_STATE.RELEASED);
  assert.equal(result.status, PROCUREMENT_STATUS.SETTLED);
});

test("never sends a release when delivery is not verified", async () => {
  const { publicClient, walletClient, calls } = fakeClients({
    escrowState: AVALANCHE_ESCROW_STATE.FUNDED,
  });

  await assert.rejects(
    releaseAward({
      publicClient,
      walletClient,
      ...baseArgs({ context: deliveredContext({ deliverableVerified: false }) }),
    }),
    ProcurementInvariantViolation,
  );
  assert.equal(calls.read.length, 0);
  assert.equal(calls.write.length, 0);
});

test("resumes successfully without sending a duplicate release when already RELEASED", async () => {
  const { publicClient, walletClient, calls } = fakeClients({
    escrowState: AVALANCHE_ESCROW_STATE.RELEASED,
  });

  const result = await releaseAward({ publicClient, walletClient, ...baseArgs() });

  assert.equal(calls.simulate.length, 0);
  assert.equal(calls.write.length, 0);
  assert.equal(result.resumedAlreadyReleased, true);
  assert.equal(result.status, PROCUREMENT_STATUS.SETTLED);
});

for (const [label, state] of [
  ["NONE", AVALANCHE_ESCROW_STATE.NONE],
  ["REFUNDED", AVALANCHE_ESCROW_STATE.REFUNDED],
]) {
  test(`throws EscrowReleaseConflictError for a ${label} escrow, writing nothing`, async () => {
    const { publicClient, walletClient, calls } = fakeClients({ escrowState: state });

    await assert.rejects(
      releaseAward({ publicClient, walletClient, ...baseArgs() }),
      EscrowReleaseConflictError,
    );
    assert.equal(calls.write.length, 0);
  });
}

test("throws EscrowTermsHashMismatchError when FUNDED with an unexpected termsHash, writing nothing", async () => {
  const { publicClient, walletClient, calls } = fakeClients({
    escrowState: AVALANCHE_ESCROW_STATE.FUNDED,
    storedTermsHash: `0x${"99".repeat(32)}`,
  });

  await assert.rejects(
    releaseAward({ publicClient, walletClient, ...baseArgs() }),
    EscrowTermsHashMismatchError,
  );
  assert.equal(calls.write.length, 0);
});

test("wraps a release transaction failure in ReleaseError", async () => {
  const { publicClient, walletClient } = fakeClients({ escrowState: AVALANCHE_ESCROW_STATE.FUNDED });
  const failingWallet = {
    ...walletClient,
    async writeContract() {
      throw new Error("release simulation reverted");
    },
  };

  await assert.rejects(
    releaseAward({ publicClient, walletClient: failingWallet, ...baseArgs() }),
    (error) => {
      assert.ok(error instanceof ReleaseError);
      assert.equal(error.procurementId, AWARD_ID);
      return true;
    },
  );
});
