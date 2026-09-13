import assert from "node:assert/strict";
import test from "node:test";

import { deriveTermsHash } from "@shadowbid/shared/commitment";
import { AVALANCHE_ESCROW_STATE } from "@shadowbid/shared/procurement";

import { EscrowTermsHashMismatchError } from "../src/fund-award.js";
import {
  EscrowRefundConflictError,
  RefundError,
  refundAward,
} from "../src/refund-award.js";

const RFQ_ID = `0x${"11".repeat(32)}`;
const QUOTE_ID = `0x${"22".repeat(32)}`;
const AWARD_ID = `0x${"33".repeat(32)}`;
const BUYER = "0x490b01048Af9878434727daF2C3291D2ff8a67B0";
const SELLER = "0x4A643d1340F779e5A58a5413eD8908F7e8DC519E";
const TOKEN = "0xEAAD2aaC9cdFE74F45F95C74E87b981561BcEbaC";
const ESCROW_ADDRESS = "0xB8d8ba69db07B957C4ce97220BF8b88E558D0738";
const SPECIFICATION_HASH = "0xb9ae219a64126660be6d2a3494f5af2ba24d265f7665fd7d9e27d595b2e54f92";
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

function fakeClients({ escrowState, storedTermsHash = COMMITMENT.termsHash, buyerBalance = 0n } = {}) {
  const calls = { read: [], simulate: [], write: [] };
  let currentEscrow = { state: escrowState, termsHash: storedTermsHash, buyer: BUYER };
  let currentBuyerBalance = buyerBalance;

  const publicClient = {
    async readContract({ functionName, args }) {
      calls.read.push(functionName);
      if (functionName === "getEscrow") return currentEscrow;
      if (functionName === "balanceOf") {
        assert.equal(args[0], BUYER);
        return currentBuyerBalance;
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
      if (request.functionName === "refundAfterDeadline") {
        currentEscrow = { state: AVALANCHE_ESCROW_STATE.REFUNDED, termsHash: storedTermsHash, buyer: BUYER };
        currentBuyerBalance += AMOUNT;
        return "0xrefundtx";
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
    ...overrides,
  };
}

test("refunds a FUNDED escrow past its deadline: Buyer receives exactly the Award amount", async () => {
  const { publicClient, walletClient, calls } = fakeClients({
    escrowState: AVALANCHE_ESCROW_STATE.FUNDED,
    buyerBalance: 10_000_000n,
  });

  const result = await refundAward({ publicClient, walletClient, ...baseArgs() });

  assert.equal(calls.write.length, 1);
  assert.equal(calls.write[0], "refundAfterDeadline");
  assert.equal(result.resumedAlreadyRefunded, false);
  assert.equal(result.refundTxHash, "0xrefundtx");
  assert.equal(result.buyerBalanceBefore, 10_000_000n);
  assert.equal(result.buyerBalanceAfter, 10_000_000n + AMOUNT);
  assert.equal(result.balanceDelta, AMOUNT);
  assert.equal(result.escrowState, AVALANCHE_ESCROW_STATE.REFUNDED);
});

test("resumes successfully without sending a duplicate refund when already REFUNDED", async () => {
  const { publicClient, walletClient, calls } = fakeClients({
    escrowState: AVALANCHE_ESCROW_STATE.REFUNDED,
  });

  const result = await refundAward({ publicClient, walletClient, ...baseArgs() });

  assert.equal(calls.simulate.length, 0);
  assert.equal(calls.write.length, 0);
  assert.equal(result.resumedAlreadyRefunded, true);
  assert.equal(result.escrowState, AVALANCHE_ESCROW_STATE.REFUNDED);
});

for (const [label, state] of [
  ["NONE", AVALANCHE_ESCROW_STATE.NONE],
  ["RELEASED", AVALANCHE_ESCROW_STATE.RELEASED],
]) {
  test(`throws EscrowRefundConflictError for a ${label} escrow, writing nothing`, async () => {
    const { publicClient, walletClient, calls } = fakeClients({ escrowState: state });

    await assert.rejects(
      refundAward({ publicClient, walletClient, ...baseArgs() }),
      EscrowRefundConflictError,
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
    refundAward({ publicClient, walletClient, ...baseArgs() }),
    EscrowTermsHashMismatchError,
  );
  assert.equal(calls.write.length, 0);
});

test("wraps a refund transaction failure in RefundError", async () => {
  const { publicClient, walletClient } = fakeClients({ escrowState: AVALANCHE_ESCROW_STATE.FUNDED });
  const failingWallet = {
    ...walletClient,
    async writeContract() {
      throw new Error("refund simulation reverted");
    },
  };

  await assert.rejects(
    refundAward({ publicClient, walletClient: failingWallet, ...baseArgs() }),
    (error) => {
      assert.ok(error instanceof RefundError);
      assert.equal(error.procurementId, AWARD_ID);
      return true;
    },
  );
});
