import { setTimeout as delay } from "node:timers/promises";

import { createPublicClient, createWalletClient, ExpirationTime } from "@arkiv-network/sdk";
import { tiramisu } from "@arkiv-network/sdk/chains";
import {
  buildOpenQuotePredicate,
  createBuyerArkivWriter,
  createSellerArkivWriter,
} from "@shadowbid/shared/arkiv";
import { formatEther, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { readBackBuyerRequest } from "../web/src/buyer-request.js";
import { publishSellerQuote } from "../web/src/seller-quote.js";
import { createBuyerAward, discoverEligibleQuotes } from "../web/src/buyer-award.js";

// The real, live 4B Buyer Request. Reused as-is: no new RFQ, no re-upload.
const RFQ_ID = "0x7adb67c16c3901c9e07d64c0ce44164e49b9d729eaf4588c064d674bf254d125";
const EXPECTED_BUYER = "0x490b01048Af9878434727daF2C3291D2ff8a67B0";
const EXPECTED_SPECIFICATION_REF =
  "506a357133b58499b326013bb4a5996d37bfdff0de6d2c411efa2aaa229a51cc";
const EXPECTED_SPECIFICATION_HASH =
  "0xb9ae219a64126660be6d2a3494f5af2ba24d265f7665fd7d9e27d595b2e54f92";

const LONG_LIFETIME = ExpirationTime.fromDays(1);
const QUOTE_B_LIFETIME_BLOCKS = 40;
const SHORT_LIFETIME = ExpirationTime.fromBlocks(QUOTE_B_LIFETIME_BLOCKS);
const QUERY_RETRIES = 12;
const QUERY_RETRY_DELAY_MS = 2_000;
const BOUNDARY_POLL_DELAY_MS = 1_000;
const BOUNDARY_WAIT_TIMEOUT_MS = 180_000;
const AWARD_DEADLINE_LEAD_SECONDS = 6n * 60n * 60n;

const REQUIRED_ACTORS = Object.freeze([
  {
    label: "Buyer",
    addressVariable: "SHADOWBID_BUYER_ADDRESS",
    privateKeyVariable: "SHADOWBID_BUYER_PRIVATE_KEY",
  },
  {
    label: "Seller A",
    addressVariable: "SHADOWBID_SELLER_A_ADDRESS",
    privateKeyVariable: "SHADOWBID_SELLER_A_PRIVATE_KEY",
  },
  {
    label: "Seller B",
    addressVariable: "SHADOWBID_SELLER_B_ADDRESS",
    privateKeyVariable: "SHADOWBID_SELLER_B_PRIVATE_KEY",
  },
]);

class ScenarioError extends Error {
  constructor(failureType, message) {
    super(message);
    this.failureType = failureType;
  }
}

function shortMessage(error) {
  return (error?.shortMessage ?? error?.message ?? String(error)).split("\n", 1)[0];
}

function classifyFailure(error) {
  if (error instanceof ScenarioError) return error.failureType;
  const message = shortMessage(error).toLowerCase();
  if (
    message.includes("insufficient funds") ||
    message.includes("exceeds the balance") ||
    message.includes("transaction reverted")
  ) {
    return "wallet/funding failure";
  }
  if (
    message.includes("fetch failed") ||
    message.includes("network") ||
    message.includes("timed out") ||
    message.includes("timeout")
  ) {
    return "Arkiv/network failure";
  }
  return error?.code === "QUOTE_NO_LONGER_ELIGIBLE" ? "eligibility failure" : "code failure";
}

function sameHex(left, right) {
  return left?.toLowerCase() === right?.toLowerCase();
}

function assertCondition(condition, message) {
  if (!condition) throw new ScenarioError("code failure", message);
}

function loadActors() {
  const missing = [];
  for (const { addressVariable, privateKeyVariable } of REQUIRED_ACTORS) {
    if (!process.env[addressVariable]) missing.push(addressVariable);
    if (!process.env[privateKeyVariable]) missing.push(privateKeyVariable);
  }
  if (missing.length > 0) {
    throw new ScenarioError(
      "configuration failure",
      `Missing required configuration: ${missing.join(", ")}`,
    );
  }

  return Object.fromEntries(
    REQUIRED_ACTORS.map(({ label, addressVariable, privateKeyVariable }) => {
      const configuredAddress = process.env[addressVariable];
      let account;
      try {
        account = privateKeyToAccount(process.env[privateKeyVariable]);
      } catch {
        throw new ScenarioError("configuration failure", `${privateKeyVariable} is invalid`);
      }
      if (!sameHex(account.address, configuredAddress)) {
        throw new ScenarioError(
          "configuration failure",
          `${privateKeyVariable} does not match ${addressVariable}`,
        );
      }
      return [label, { account, address: account.address }];
    }),
  );
}

async function requireSuccessfulReceipt(publicClient, hash, label) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  assertCondition(receipt.status === "success", `${label} transaction reverted`);
  return receipt;
}

function quoteIds(page) {
  return page.entities.map((entity) => entity.attributes.quote_id?.value).sort();
}

function hasExactQuoteIds(page, expectedIds) {
  const returned = quoteIds(page);
  return (
    page.entities.length === expectedIds.length &&
    returned.length === expectedIds.length &&
    returned.every((id, index) => id === expectedIds[index])
  );
}

async function waitForDiscoveryResult(criteria, expectedIds, phase, boundaryBlock) {
  for (let attempt = 1; attempt <= QUERY_RETRIES; attempt += 1) {
    const page = await discoverEligibleQuotes(criteria);
    if (hasExactQuoteIds(page, expectedIds)) return page;
    if (phase === "BEFORE" && page.blockNumber > boundaryBlock) {
      throw new ScenarioError(
        "Arkiv/network failure",
        "Quote B expired before the BEFORE discovery result became observable",
      );
    }
    if (attempt < QUERY_RETRIES) await delay(QUERY_RETRY_DELAY_MS);
  }
  throw new ScenarioError(
    "Arkiv/network failure",
    `${phase} discovery did not return the expected quote IDs after ${QUERY_RETRIES} attempts`,
  );
}

async function waitPastExpiryBoundary(publicClient, expiresAt) {
  const startedAt = Date.now();
  const deadline = startedAt + BOUNDARY_WAIT_TIMEOUT_MS;
  let observedBlock = await publicClient.getBlockNumber();

  while (observedBlock <= expiresAt) {
    if (Date.now() >= deadline) {
      throw new ScenarioError(
        "Arkiv/network failure",
        `Timed out waiting past Quote B expiry block ${expiresAt}`,
      );
    }
    await delay(BOUNDARY_POLL_DELAY_MS);
    observedBlock = await publicClient.getBlockNumber();
  }

  return { observedBlock, waitedMs: Date.now() - startedAt };
}

async function run() {
  const actors = loadActors();
  const buyer = actors.Buyer;
  const sellerA = actors["Seller A"];
  const sellerB = actors["Seller B"];
  const rpcUrl = tiramisu.rpcUrls.default.http[0];
  const publicClient = createPublicClient({ chain: tiramisu, transport: http(rpcUrl) });

  const chainId = await publicClient.getChainId();
  assertCondition(chainId === tiramisu.id, `Unexpected chain ID ${chainId}`);

  const balances = await Promise.all(
    [buyer, sellerA, sellerB].map(({ address }) => publicClient.getBalance({ address })),
  );
  const unfunded = ["Buyer", "Seller A", "Seller B"].filter((_l, i) => balances[i] === 0n);
  if (unfunded.length > 0) {
    throw new ScenarioError("wallet/funding failure", `Unfunded wallets: ${unfunded.join(", ")}`);
  }

  const buyerWriter = createBuyerArkivWriter({
    walletClient: createWalletClient({ account: buyer.account, chain: tiramisu, transport: http(rpcUrl) }),
    buyer: buyer.address,
  });
  const sellerAWriter = createSellerArkivWriter({
    walletClient: createWalletClient({ account: sellerA.account, chain: tiramisu, transport: http(rpcUrl) }),
    seller: sellerA.address,
  });
  const sellerBWriter = createSellerArkivWriter({
    walletClient: createWalletClient({ account: sellerB.account, chain: tiramisu, transport: http(rpcUrl) }),
    seller: sellerB.address,
  });

  // Step 0: the real 4B RFQ is still the one carrying the real specification linkage.
  const rfq = await readBackBuyerRequest({ arkivPublicClient: publicClient, rfqId: RFQ_ID });
  assertCondition(rfq !== undefined, "Real 4B RFQ could not be read back from Arkiv");
  assertCondition(sameHex(rfq.buyer, EXPECTED_BUYER), "RFQ buyer does not match the expected Buyer");
  assertCondition(
    rfq.specificationRef === EXPECTED_SPECIFICATION_REF,
    "RFQ payload specificationRef does not match the expected Slice 3B/4B evidence",
  );
  assertCondition(
    rfq.specificationHash === EXPECTED_SPECIFICATION_HASH,
    "RFQ payload specificationHash does not match the expected Slice 3B/4B evidence",
  );

  const createdAt = BigInt(Math.floor(Date.now() / 1_000));

  // A: Seller A and Seller B each submit a real Quote via the new use-case.
  const quoteA = await publishSellerQuote({
    sellerArkivWriter: sellerAWriter,
    arkivPublicClient: publicClient,
    rfqId: RFQ_ID,
    price: 350_000n,
    etaMinutes: 20n,
    createdAt,
    expires: LONG_LIFETIME,
  });
  await requireSuccessfulReceipt(publicClient, quoteA.quoteTxHash, "Quote A");

  const quoteB = await publishSellerQuote({
    sellerArkivWriter: sellerBWriter,
    arkivPublicClient: publicClient,
    rfqId: RFQ_ID,
    price: 250_000n,
    etaMinutes: 10n,
    createdAt,
    expires: SHORT_LIFETIME,
  });
  await requireSuccessfulReceipt(publicClient, quoteB.quoteTxHash, "Quote B");

  // B: real canonical discovery, before and after Quote B's natural expiry.
  const discoveryCriteria = {
    arkivPublicClient: publicClient,
    rfqId: RFQ_ID,
    budget: rfq.maxBudget,
    maxEtaMinutes: rfq.maxEtaMinutes,
  };
  const predicateText = String(
    buildOpenQuotePredicate({ rfqId: RFQ_ID, budget: rfq.maxBudget, maxEtaMinutes: rfq.maxEtaMinutes }),
  );

  const beforeExpectedIds = [quoteA.quoteId, quoteB.quoteId].sort();
  const beforePage = await waitForDiscoveryResult(
    discoveryCriteria,
    beforeExpectedIds,
    "BEFORE",
    quoteB.quoteExpiresAt,
  );

  const boundary = await waitPastExpiryBoundary(publicClient, quoteB.quoteExpiresAt);
  const afterPage = await waitForDiscoveryResult(
    discoveryCriteria,
    [quoteA.quoteId],
    "AFTER",
    quoteB.quoteExpiresAt,
  );
  assertCondition(
    afterPage.blockNumber > quoteB.quoteExpiresAt,
    "AFTER discovery did not execute past Quote B's expiry block",
  );

  // C + D: revalidate Quote A and create the real Buyer-owned Award from it.
  const awardDeadline = BigInt(Math.floor(Date.now() / 1_000)) + AWARD_DEADLINE_LEAD_SECONDS;
  const award = await createBuyerAward({
    buyerArkivWriter: buyerWriter,
    arkivPublicClient: publicClient,
    rfqId: RFQ_ID,
    selectedQuoteId: quoteA.quoteId,
    deadline: awardDeadline,
    createdAt: BigInt(Math.floor(Date.now() / 1_000)),
    expires: LONG_LIFETIME,
  });
  await requireSuccessfulReceipt(publicClient, award.awardTxHash, "Award");

  const awardEntity = await publicClient.getEntity(award.awardEntityKey);
  assertCondition(
    sameHex(awardEntity.owner, buyer.address) &&
      awardEntity.attributes.rfq_id?.value === RFQ_ID &&
      awardEntity.attributes.quote_id?.value === quoteA.quoteId &&
      sameHex(awardEntity.attributes.seller?.value, sellerA.address) &&
      awardEntity.attributes.amount?.value === 350_000n,
    "Independent Award readback does not match the created Award",
  );

  console.log("[SHADOWBID SLICE 4C QUOTES + AWARD LIVE]");
  console.log(`arkivNetwork: ${tiramisu.name}`);
  console.log(`arkivNetworkId: ${chainId}`);
  console.log(`buyer: ${buyer.address}`);
  console.log(`sellerA: ${sellerA.address}`);
  console.log(`sellerB: ${sellerB.address}`);
  console.log(`rfqId: ${RFQ_ID}`);
  console.log(`rfqBuyer: ${rfq.buyer}`);
  console.log(`rfqSpecificationRef: ${rfq.specificationRef}`);
  console.log(`rfqSpecificationHash: ${rfq.specificationHash}`);
  console.log("--- Quote A (long-lived) ---");
  console.log(`quoteAId: ${quoteA.quoteId}`);
  console.log(`quoteAEntityKey: ${quoteA.quoteEntityKey}`);
  console.log(`quoteATxHash: ${quoteA.quoteTxHash}`);
  console.log(`quoteAPrice: ${quoteA.price}`);
  console.log(`quoteAEtaMinutes: ${quoteA.etaMinutes}`);
  console.log("quoteALifetime: 1 day (Arkiv native)");
  console.log(`quoteAExpiresAtBlock: ${quoteA.quoteExpiresAt}`);
  console.log("--- Quote B (short-lived, expires naturally) ---");
  console.log(`quoteBId: ${quoteB.quoteId}`);
  console.log(`quoteBEntityKey: ${quoteB.quoteEntityKey}`);
  console.log(`quoteBTxHash: ${quoteB.quoteTxHash}`);
  console.log(`quoteBPrice: ${quoteB.price}`);
  console.log(`quoteBEtaMinutes: ${quoteB.etaMinutes}`);
  console.log(`quoteBLifetime: ${QUOTE_B_LIFETIME_BLOCKS} blocks (Arkiv native)`);
  console.log(`quoteBExpiresAtBlock: ${quoteB.quoteExpiresAt}`);
  console.log("--- discovery (real canonical Arkiv compound query) ---");
  console.log(`predicate: ${predicateText}`);
  console.log(`beforeQueryBlock: ${beforePage.blockNumber}`);
  console.log(`beforeReturnedQuoteIds: ${quoteIds(beforePage).join(",")}`);
  console.log(`boundaryObservedBlock: ${boundary.observedBlock}`);
  console.log(`boundaryWaitMs: ${boundary.waitedMs}`);
  console.log(`afterQueryBlock: ${afterPage.blockNumber}`);
  console.log(`afterReturnedQuoteIds: ${quoteIds(afterPage).join(",")}`);
  console.log("filtering: ARKIV (server-side compound predicate, no JS post-filtering)");
  console.log("deleteUsed: NO");
  console.log("expiryAuthority: ARKIV_NATIVE_BLOCK_EXPIRY");
  console.log("--- Award (separate Buyer-owned entity) ---");
  console.log(`awardId: ${award.awardId}`);
  console.log(`awardEntityKey: ${award.awardEntityKey}`);
  console.log(`awardTxHash: ${award.awardTxHash}`);
  console.log(`procurementId: ${award.procurementId}`);
  console.log(`procurementIdEqualsAwardId: ${award.procurementId === award.awardId}`);
  console.log(`awardRfqId: ${award.rfqId}`);
  console.log(`awardQuoteId: ${award.quoteId}`);
  console.log(`awardBuyer: ${award.buyer}`);
  console.log(`awardSeller: ${award.seller}`);
  console.log(`awardAmount: ${award.amount}`);
  console.log(`awardSettlementAsset: ${award.settlementAsset}`);
  console.log(`awardDeadline: ${award.deadline}`);
  console.log(`resumedExistingAward: ${award.resumedExistingAward}`);
  console.log(`independentAwardReadbackMatches: true`);
  console.log(`contextSpecificationRef: ${award.context.specificationRef}`);
  console.log(`contextSpecificationHash: ${award.context.specificationHash}`);
  console.log(
    `specificationContinuity: ${
      award.specificationRef === EXPECTED_SPECIFICATION_REF &&
      award.specificationHash === EXPECTED_SPECIFICATION_HASH
    }`,
  );
  console.log("termsHashComputed: NO (deferred to Slice 4D)");
  console.log("fundingUsed: NO");
  console.log("status: PASS");
}

try {
  await run();
} catch (error) {
  console.error("[SHADOWBID SLICE 4C QUOTES + AWARD LIVE]");
  console.error("status: FAIL");
  console.error(`failureType: ${classifyFailure(error)}`);
  console.error(`message: ${shortMessage(error)}`);
  process.exitCode = 1;
}
