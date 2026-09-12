import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { network } from "hardhat";
import { keccak256, stringToHex, zeroAddress, zeroHash } from "viem";

const { viem, networkHelpers } = await network.create();

const PROCUREMENT_ID = keccak256(stringToHex("shadowbid-award-1"));
const UNKNOWN_ID = keccak256(stringToHex("shadowbid-award-unknown"));
const TERMS_HASH = keccak256(stringToHex("shadowbid-terms-1"));
const AMOUNT = 500_000n;
const INITIAL_BALANCE = 2_000_000n;

const State = Object.freeze({
  NONE: 0,
  FUNDED: 1,
  RELEASED: 2,
  REFUNDED: 3,
});

async function deployFixture() {
  const [buyer, seller, caller] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();
  const token = await viem.deployContract("MockERC20");
  const escrow = await viem.deployContract("ShadowBidEscrow");

  await token.write.mint([buyer.account.address, INITIAL_BALANCE]);

  return { buyer, seller, caller, publicClient, token, escrow };
}

async function futureDeadline(publicClient, seconds = 3_600n) {
  const block = await publicClient.getBlock();
  return block.timestamp + seconds;
}

async function fundEscrow(context, overrides = {}) {
  const { buyer, seller, publicClient, token, escrow } = context;
  const parameters = {
    procurementId: PROCUREMENT_ID,
    seller: seller.account.address,
    token: token.address,
    amount: AMOUNT,
    termsHash: TERMS_HASH,
    deadline: await futureDeadline(publicClient),
    ...overrides,
  };

  if (overrides.approve !== false) {
    await token.write.approve([escrow.address, parameters.amount], {
      account: buyer.account,
    });
  }

  await escrow.write.fund(
    [
      parameters.procurementId,
      parameters.seller,
      parameters.token,
      parameters.amount,
      parameters.termsHash,
      parameters.deadline,
    ],
    { account: buyer.account },
  );

  return parameters;
}

async function expectCustomError(action, errorName) {
  await assert.rejects(action, (error) => {
    const details = `${error?.shortMessage ?? ""}\n${error?.message ?? ""}`;
    assert.match(details, new RegExp(errorName));
    return true;
  });
}

function assertStoredEscrow(actual, expected, state) {
  assert.equal(actual.buyer.toLowerCase(), expected.buyer.toLowerCase());
  assert.equal(actual.seller.toLowerCase(), expected.seller.toLowerCase());
  assert.equal(actual.token.toLowerCase(), expected.token.toLowerCase());
  assert.equal(actual.amount, expected.amount);
  assert.equal(actual.termsHash, expected.termsHash);
  assert.equal(actual.deadline, expected.deadline);
  assert.equal(actual.state, state);
}

describe("ShadowBidEscrow fund", () => {
  test("funds successfully and stores the immutable escrow fields", async () => {
    const context = await networkHelpers.loadFixture(deployFixture);
    const parameters = await fundEscrow(context);
    const stored = await context.escrow.read.getEscrow([PROCUREMENT_ID]);

    assertStoredEscrow(
      stored,
      {
        buyer: context.buyer.account.address,
        seller: parameters.seller,
        token: parameters.token,
        amount: AMOUNT,
        termsHash: TERMS_HASH,
        deadline: parameters.deadline,
      },
      State.FUNDED,
    );
    assert.equal(await context.token.read.balanceOf([context.escrow.address]), AMOUNT);
    assert.equal(
      await context.token.read.balanceOf([context.buyer.account.address]),
      INITIAL_BALANCE - AMOUNT,
    );
  });

  test("rejects duplicate procurementId", async () => {
    const context = await networkHelpers.loadFixture(deployFixture);
    const first = await fundEscrow(context);
    await context.token.write.approve([context.escrow.address, AMOUNT], {
      account: context.buyer.account,
    });

    await expectCustomError(
      context.escrow.write.fund(
        [PROCUREMENT_ID, first.seller, first.token, AMOUNT, TERMS_HASH, first.deadline],
        { account: context.buyer.account },
      ),
      "EscrowAlreadyExists",
    );
  });

  test("rejects zero procurementId", async () => {
    const context = await networkHelpers.loadFixture(deployFixture);
    await expectCustomError(fundEscrow(context, { procurementId: zeroHash }), "InvalidProcurementId");
  });

  test("rejects zero seller", async () => {
    const context = await networkHelpers.loadFixture(deployFixture);
    await expectCustomError(fundEscrow(context, { seller: zeroAddress }), "InvalidSeller");
  });

  test("rejects zero token", async () => {
    const context = await networkHelpers.loadFixture(deployFixture);
    await expectCustomError(fundEscrow(context, { token: zeroAddress }), "InvalidToken");
  });

  test("rejects zero amount", async () => {
    const context = await networkHelpers.loadFixture(deployFixture);
    await expectCustomError(fundEscrow(context, { amount: 0n }), "InvalidAmount");
  });

  test("rejects zero termsHash", async () => {
    const context = await networkHelpers.loadFixture(deployFixture);
    await expectCustomError(fundEscrow(context, { termsHash: zeroHash }), "InvalidTermsHash");
  });

  test("rejects current and past deadlines", async () => {
    const context = await networkHelpers.loadFixture(deployFixture);
    const current = (await context.publicClient.getBlock()).timestamp;

    await expectCustomError(fundEscrow(context, { deadline: current }), "InvalidDeadline");
    await expectCustomError(fundEscrow(context, { deadline: current - 1n }), "InvalidDeadline");
  });

  test("rejects insufficient allowance", async () => {
    const context = await networkHelpers.loadFixture(deployFixture);
    await expectCustomError(
      fundEscrow(context, { approve: false }),
      "TokenTransferFailed",
    );
  });

  test("rejects insufficient balance", async () => {
    const context = await networkHelpers.loadFixture(deployFixture);
    await expectCustomError(
      fundEscrow(context, { amount: INITIAL_BALANCE + 1n }),
      "TokenTransferFailed",
    );
  });

  test("supports a non-standard ERC-20 that returns no boolean", async () => {
    const context = await networkHelpers.loadFixture(deployFixture);
    const token = await viem.deployContract("MockNoReturnERC20");
    await token.write.mint([context.buyer.account.address, AMOUNT]);
    await token.write.approve([context.escrow.address, AMOUNT], {
      account: context.buyer.account,
    });
    const deadline = await futureDeadline(context.publicClient);

    await context.escrow.write.fund(
      [PROCUREMENT_ID, context.seller.account.address, token.address, AMOUNT, TERMS_HASH, deadline],
      { account: context.buyer.account },
    );
    await context.escrow.write.release([PROCUREMENT_ID], { account: context.buyer.account });

    assert.equal(await token.read.balanceOf([context.seller.account.address]), AMOUNT);
  });
});

describe("ShadowBidEscrow release", () => {
  test("lets only the Buyer release the exact amount to the stored Seller", async () => {
    const context = await networkHelpers.loadFixture(deployFixture);
    const parameters = await fundEscrow(context);

    await context.escrow.write.release([PROCUREMENT_ID], { account: context.buyer.account });

    assert.equal(await context.token.read.balanceOf([context.seller.account.address]), AMOUNT);
    assert.equal(await context.token.read.balanceOf([context.escrow.address]), 0n);
    const stored = await context.escrow.read.getEscrow([PROCUREMENT_ID]);
    assertStoredEscrow(
      stored,
      {
        buyer: context.buyer.account.address,
        seller: parameters.seller,
        token: parameters.token,
        amount: AMOUNT,
        termsHash: TERMS_HASH,
        deadline: parameters.deadline,
      },
      State.RELEASED,
    );
  });

  test("rejects a non-Buyer", async () => {
    const context = await networkHelpers.loadFixture(deployFixture);
    await fundEscrow(context);
    await expectCustomError(
      context.escrow.write.release([PROCUREMENT_ID], { account: context.seller.account }),
      "OnlyBuyer",
    );
  });

  test("rejects an unknown escrow", async () => {
    const context = await networkHelpers.loadFixture(deployFixture);
    await expectCustomError(
      context.escrow.write.release([UNKNOWN_ID], { account: context.buyer.account }),
      "EscrowNotFunded",
    );
  });

  test("rejects double release", async () => {
    const context = await networkHelpers.loadFixture(deployFixture);
    await fundEscrow(context);
    await context.escrow.write.release([PROCUREMENT_ID], { account: context.buyer.account });
    await expectCustomError(
      context.escrow.write.release([PROCUREMENT_ID], { account: context.buyer.account }),
      "EscrowNotFunded",
    );
  });

  test("rejects release after refund", async () => {
    const context = await networkHelpers.loadFixture(deployFixture);
    const parameters = await fundEscrow(context);
    await networkHelpers.time.increaseTo(parameters.deadline);
    await context.escrow.write.refundAfterDeadline([PROCUREMENT_ID], {
      account: context.caller.account,
    });

    await expectCustomError(
      context.escrow.write.release([PROCUREMENT_ID], { account: context.buyer.account }),
      "EscrowNotFunded",
    );
  });

  test("still releases after the deadline while FUNDED", async () => {
    const context = await networkHelpers.loadFixture(deployFixture);
    const parameters = await fundEscrow(context);
    await networkHelpers.time.increaseTo(parameters.deadline);

    await context.escrow.write.release([PROCUREMENT_ID], { account: context.buyer.account });

    assert.equal(await context.token.read.balanceOf([context.seller.account.address]), AMOUNT);
    assert.equal((await context.escrow.read.getEscrow([PROCUREMENT_ID])).state, State.RELEASED);
  });
});

describe("ShadowBidEscrow refundAfterDeadline", () => {
  test("rejects refund before the deadline", async () => {
    const context = await networkHelpers.loadFixture(deployFixture);
    await fundEscrow(context);
    await expectCustomError(
      context.escrow.write.refundAfterDeadline([PROCUREMENT_ID], {
        account: context.caller.account,
      }),
      "InvalidDeadline",
    );
  });

  test("lets anyone refund the exact amount only to the stored Buyer", async () => {
    const context = await networkHelpers.loadFixture(deployFixture);
    const parameters = await fundEscrow(context);
    const callerBalanceBefore = await context.token.read.balanceOf([
      context.caller.account.address,
    ]);
    await networkHelpers.time.increaseTo(parameters.deadline);

    await context.escrow.write.refundAfterDeadline([PROCUREMENT_ID], {
      account: context.caller.account,
    });

    assert.equal(
      await context.token.read.balanceOf([context.buyer.account.address]),
      INITIAL_BALANCE,
    );
    assert.equal(
      await context.token.read.balanceOf([context.caller.account.address]),
      callerBalanceBefore,
    );
    assert.equal(await context.token.read.balanceOf([context.escrow.address]), 0n);
    const stored = await context.escrow.read.getEscrow([PROCUREMENT_ID]);
    assertStoredEscrow(
      stored,
      {
        buyer: context.buyer.account.address,
        seller: parameters.seller,
        token: parameters.token,
        amount: AMOUNT,
        termsHash: TERMS_HASH,
        deadline: parameters.deadline,
      },
      State.REFUNDED,
    );
  });

  test("rejects refund after release", async () => {
    const context = await networkHelpers.loadFixture(deployFixture);
    const parameters = await fundEscrow(context);
    await context.escrow.write.release([PROCUREMENT_ID], { account: context.buyer.account });
    await networkHelpers.time.increaseTo(parameters.deadline);

    await expectCustomError(
      context.escrow.write.refundAfterDeadline([PROCUREMENT_ID], {
        account: context.caller.account,
      }),
      "EscrowNotFunded",
    );
  });

  test("rejects double refund", async () => {
    const context = await networkHelpers.loadFixture(deployFixture);
    const parameters = await fundEscrow(context);
    await networkHelpers.time.increaseTo(parameters.deadline);
    await context.escrow.write.refundAfterDeadline([PROCUREMENT_ID], {
      account: context.caller.account,
    });

    await expectCustomError(
      context.escrow.write.refundAfterDeadline([PROCUREMENT_ID], {
        account: context.caller.account,
      }),
      "EscrowNotFunded",
    );
  });

  test("rejects an unknown escrow", async () => {
    const context = await networkHelpers.loadFixture(deployFixture);
    await networkHelpers.time.increase(3_600);
    await expectCustomError(
      context.escrow.write.refundAfterDeadline([UNKNOWN_ID], {
        account: context.caller.account,
      }),
      "EscrowNotFunded",
    );
  });
});
