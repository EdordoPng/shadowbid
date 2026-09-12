import assert from "node:assert/strict";
import test from "node:test";

import { deriveTermsHash } from "@shadowbid/shared/commitment";
import { AVALANCHE_ESCROW_STATE } from "@shadowbid/shared/procurement";

import {
  EscrowFundingConflictError,
  EscrowTermsHashMismatchError,
  FundingError,
  fundAward,
  readAwardCommitmentInputs,
} from "../src/fund-award.js";

const RFQ_ID = `0x${"11".repeat(32)}`;
const QUOTE_ID = `0x${"22".repeat(32)}`;
const AWARD_ID = `0x${"33".repeat(32)}`;
const BUYER = "0x490b01048Af9878434727daF2C3291D2ff8a67B0";
const SELLER = "0x4A643d1340F779e5A58a5413eD8908F7e8DC519E";
const TOKEN = "0xEAAD2aaC9cdFE74F45F95C74E87b981561BcEbaC";
const ESCROW_ADDRESS = "0xB8d8ba69db07B957C4ce97220BF8b88E558D0738";
const SPECIFICATION_REF = "506a357133b58499b326013bb4a5996d37bfdff0de6d2c411efa2aaa229a51cc";
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

function value(v) {
  return { value: v };
}

function entityTypeOf(predicate) {
  return predicate.expressions.find((expression) => expression.name === "entity_type").value
    .value;
}

function fakeArkivPublicClient() {
  const awardEntity = {
    key: "0xaward-entity",
    attributes: {
      entity_type: value("award"),
      rfq_id: value(RFQ_ID),
      quote_id: value(QUOTE_ID),
      buyer: value(BUYER),
      seller: value(SELLER),
      amount: value(AMOUNT),
      deadline: value(DEADLINE),
      settlement_asset: value("usdc"),
    },
  };
  const rfqEntity = {
    key: "0xrfq-entity",
    attributes: {
      rfq_id: value(RFQ_ID),
      buyer: value(BUYER),
      status: value("open"),
      max_budget: value(500_000n),
      max_eta_minutes: value(60n),
    },
    toJson: () => ({
      title: "ShadowBid Slice 4B live Buyer Request",
      specificationRef: SPECIFICATION_REF,
      specificationHash: SPECIFICATION_HASH,
    }),
  };

  return {
    select() {
      let capturedPredicate;
      return {
        where(predicate) {
          capturedPredicate = predicate;
          return this;
        },
        limit() {
          return this;
        },
        async fetch() {
          const type = entityTypeOf(capturedPredicate);
          if (type === "award") return { entities: [awardEntity] };
          if (type === "rfq") return { entities: [rfqEntity] };
          return { entities: [] };
        },
      };
    },
  };
}

function fakeClients({
  escrowState,
  storedTermsHash,
  allowance = 0n,
  failApprove = false,
  failFund = false,
} = {}) {
  const calls = { read: [], simulate: [], write: [] };
  let currentEscrow = {
    state: escrowState,
    buyer: escrowState === AVALANCHE_ESCROW_STATE.NONE ? undefined : BUYER,
    seller: escrowState === AVALANCHE_ESCROW_STATE.NONE ? undefined : SELLER,
    token: escrowState === AVALANCHE_ESCROW_STATE.NONE ? undefined : TOKEN,
    amount: escrowState === AVALANCHE_ESCROW_STATE.NONE ? undefined : AMOUNT,
    termsHash: storedTermsHash,
    deadline: escrowState === AVALANCHE_ESCROW_STATE.NONE ? undefined : DEADLINE,
  };
  let currentAllowance = allowance;

  const publicClient = {
    async readContract({ functionName }) {
      calls.read.push(functionName);
      if (functionName === "getEscrow") return currentEscrow;
      if (functionName === "allowance") return currentAllowance;
      throw new Error(`unexpected read ${functionName}`);
    },
    async simulateContract({ functionName, args }) {
      calls.simulate.push(functionName);
      if (functionName === "approve" && failApprove) throw new Error("approve simulation reverted");
      if (functionName === "fund" && failFund) throw new Error("fund simulation reverted");
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
      if (request.functionName === "approve") {
        currentAllowance = request.args[1];
        return "0xapprovetx";
      }
      if (request.functionName === "fund") {
        currentEscrow = {
          state: AVALANCHE_ESCROW_STATE.FUNDED,
          buyer: BUYER,
          seller: request.args[1],
          token: request.args[2],
          amount: request.args[3],
          termsHash: request.args[4],
          deadline: request.args[5],
        };
        return "0xfundtx";
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

test("reconstructs escrow commitment inputs from the real Award/RFQ via the existing shared primitive", async () => {
  const arkivPublicClient = fakeArkivPublicClient();

  const commitment = await readAwardCommitmentInputs({
    arkivPublicClient,
    awardId: AWARD_ID,
    token: TOKEN,
  });

  assert.equal(commitment.procurementId, AWARD_ID);
  assert.equal(commitment.seller, SELLER);
  assert.equal(commitment.token, TOKEN);
  assert.equal(commitment.amount, AMOUNT);
  assert.equal(commitment.deadline, DEADLINE);
  assert.equal(commitment.termsHash, COMMITMENT.termsHash);
});

test("funds a NONE escrow, skipping approve when allowance already covers the amount", async () => {
  const { publicClient, walletClient, calls } = fakeClients({
    escrowState: AVALANCHE_ESCROW_STATE.NONE,
    allowance: AMOUNT,
  });

  const result = await fundAward({ publicClient, walletClient, ...baseArgs() });

  assert.equal(calls.write.includes("approve"), false);
  assert.equal(calls.write.includes("fund"), true);
  assert.equal(result.resumedAlreadyFunded, false);
  assert.equal(result.approveTxHash, undefined);
  assert.equal(result.fundingTxHash, "0xfundtx");
  assert.equal(result.escrowState, AVALANCHE_ESCROW_STATE.FUNDED);
  assert.equal(result.storedTermsHash, COMMITMENT.termsHash);
  assert.equal(result.computedTermsHash, COMMITMENT.termsHash);
});

test("approves once when allowance is insufficient, then funds", async () => {
  const { publicClient, walletClient, calls } = fakeClients({
    escrowState: AVALANCHE_ESCROW_STATE.NONE,
    allowance: 0n,
  });

  const stages = [];
  const result = await fundAward({ publicClient, walletClient, ...baseArgs(), onStage: stage => stages.push(stage) });

  assert.deepEqual(calls.write, ["approve", "fund"]);
  assert.equal(result.approveTxHash, "0xapprovetx");
  assert.equal(result.allowanceBefore, 0n);
  assert.equal(result.allowanceAfter, AMOUNT);
  assert.equal(result.fundingTxHash, "0xfundtx");
  assert.deepEqual(stages, [
    "Preparing transaction", "Confirm in wallet", "Waiting for Fuji",
    "Confirm in wallet", "Waiting for Fuji", "Funded",
  ]);
});

test("resumes successfully without sending any transaction when already FUNDED with a matching termsHash", async () => {
  const { publicClient, walletClient, calls } = fakeClients({
    escrowState: AVALANCHE_ESCROW_STATE.FUNDED,
    storedTermsHash: COMMITMENT.termsHash,
  });

  const result = await fundAward({ publicClient, walletClient, ...baseArgs() });

  assert.equal(calls.simulate.length, 0);
  assert.equal(calls.write.length, 0);
  assert.equal(result.resumedAlreadyFunded, true);
  assert.equal(result.storedTermsHash, COMMITMENT.termsHash);
});

test("throws EscrowTermsHashMismatchError when FUNDED with a different termsHash, writing nothing", async () => {
  const { publicClient, walletClient, calls } = fakeClients({
    escrowState: AVALANCHE_ESCROW_STATE.FUNDED,
    storedTermsHash: `0x${"99".repeat(32)}`,
  });

  await assert.rejects(
    fundAward({ publicClient, walletClient, ...baseArgs() }),
    EscrowTermsHashMismatchError,
  );
  assert.equal(calls.write.length, 0);
});

for (const [label, state] of [
  ["RELEASED", AVALANCHE_ESCROW_STATE.RELEASED],
  ["REFUNDED", AVALANCHE_ESCROW_STATE.REFUNDED],
]) {
  test(`throws EscrowFundingConflictError for a terminal ${label} escrow, writing nothing`, async () => {
    const { publicClient, walletClient, calls } = fakeClients({ escrowState: state });

    await assert.rejects(
      fundAward({ publicClient, walletClient, ...baseArgs() }),
      EscrowFundingConflictError,
    );
    assert.equal(calls.write.length, 0);
  });
}

test("wraps a fund transaction failure in FundingError", async () => {
  const { publicClient, walletClient } = fakeClients({
    escrowState: AVALANCHE_ESCROW_STATE.NONE,
    allowance: AMOUNT,
    failFund: true,
  });

  await assert.rejects(
    fundAward({ publicClient, walletClient, ...baseArgs() }),
    (error) => {
      assert.ok(error instanceof FundingError);
      assert.equal(error.procurementId, AWARD_ID);
      return true;
    },
  );
});
