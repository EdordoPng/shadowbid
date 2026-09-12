import assert from "node:assert/strict";
import test from "node:test";

import { network } from "hardhat";

import {
  TERMS_HASH_VERSION,
  deriveTermsHash,
  hashSpecification,
} from "@shadowbid/shared/commitment";

const { viem } = await network.create();

test("termsHash matches Solidity abi.encode plus keccak256", async () => {
  const [buyer, seller, token] = await viem.getWalletClients();
  const harness = await viem.deployContract("TermsHashHarness");
  const input = {
    rfqId: `0x${"11".repeat(32)}`,
    quoteId: `0x${"22".repeat(32)}`,
    awardId: `0x${"33".repeat(32)}`,
    buyer: buyer.account.address,
    seller: seller.account.address,
    token: token.account.address,
    amount: 350_000n,
    deadline: 1_800_003_600n,
    specificationHash: hashSpecification("Review the payment contract"),
  };

  const solidityHash = await harness.read.hashTerms([
    TERMS_HASH_VERSION,
    input.rfqId,
    input.quoteId,
    input.awardId,
    input.buyer,
    input.seller,
    input.token,
    input.amount,
    input.deadline,
    input.specificationHash,
  ]);

  assert.equal(deriveTermsHash(input), solidityHash);
});
