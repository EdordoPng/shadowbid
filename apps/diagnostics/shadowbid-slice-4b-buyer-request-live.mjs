import { setTimeout as delay } from "node:timers/promises";

import { createPublicClient, createWalletClient, ExpirationTime } from "@arkiv-network/sdk";
import { tiramisu } from "@arkiv-network/sdk/chains";
import { createBuyerArkivWriter } from "@shadowbid/shared/arkiv";
import { formatEther, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { publishBuyerRequest, readBackBuyerRequest } from "../web/src/buyer-request.js";

// Real Swarm evidence obtained live via apps/web/swarm-smoke.html (Connect +
// "Run Slice 3C"). Reused here through the Slice 4B retry path: no re-upload.
const SPECIFICATION_REF =
  "506a357133b58499b326013bb4a5996d37bfdff0de6d2c411efa2aaa229a51cc";
const SPECIFICATION_HASH =
  "0xb9ae219a64126660be6d2a3494f5af2ba24d265f7665fd7d9e27d595b2e54f92";

const READ_RETRIES = 12;
const READ_RETRY_DELAY_MS = 2_000;

class ScenarioError extends Error {
  constructor(failureType, message) {
    super(message);
    this.failureType = failureType;
  }
}

function shortMessage(error) {
  return (error?.shortMessage ?? error?.message ?? String(error)).split("\n", 1)[0];
}

function loadBuyer() {
  const address = process.env.SHADOWBID_BUYER_ADDRESS;
  const privateKey = process.env.SHADOWBID_BUYER_PRIVATE_KEY;
  if (!address || !privateKey) {
    throw new ScenarioError(
      "wallet/gas failure",
      "SHADOWBID_BUYER_ADDRESS and SHADOWBID_BUYER_PRIVATE_KEY are required",
    );
  }

  let account;
  try {
    account = privateKeyToAccount(privateKey);
  } catch {
    throw new ScenarioError("wallet/gas failure", "Buyer private key is invalid");
  }
  if (account.address.toLowerCase() !== address.toLowerCase()) {
    throw new ScenarioError(
      "wallet/gas failure",
      "Buyer private key does not match SHADOWBID_BUYER_ADDRESS",
    );
  }

  return account;
}

async function readBackWithRetry(publicClient, rfqId) {
  for (let attempt = 1; attempt <= READ_RETRIES; attempt += 1) {
    const readBack = await readBackBuyerRequest({ arkivPublicClient: publicClient, rfqId });
    if (readBack) return readBack;
    if (attempt === READ_RETRIES) {
      throw new ScenarioError(
        "Arkiv failure",
        `RFQ readback found nothing after ${READ_RETRIES} attempts`,
      );
    }
    await delay(READ_RETRY_DELAY_MS);
  }

  throw new ScenarioError("code failure", "Read retry loop ended unexpectedly");
}

async function run() {
  const buyer = loadBuyer();
  const rpcUrl = tiramisu.rpcUrls.default.http[0];
  const publicClient = createPublicClient({ chain: tiramisu, transport: http(rpcUrl) });
  const walletClient = createWalletClient({ account: buyer, chain: tiramisu, transport: http(rpcUrl) });

  const chainId = await publicClient.getChainId();
  if (chainId !== tiramisu.id) {
    throw new ScenarioError("Arkiv/network failure", `Unexpected chain ID ${chainId}`);
  }

  const buyerBalance = await publicClient.getBalance({ address: buyer.address });
  if (buyerBalance === 0n) {
    throw new ScenarioError("wallet/funding failure", "Buyer has no Tiramisu balance for gas");
  }

  const buyerArkivWriter = createBuyerArkivWriter({ walletClient, buyer: buyer.address });
  const createdAt = BigInt(Math.floor(Date.now() / 1_000));

  const result = await publishBuyerRequest({
    buyerArkivWriter,
    arkivPublicClient: publicClient,
    specificationRef: SPECIFICATION_REF,
    specificationHash: SPECIFICATION_HASH,
    title: "ShadowBid Slice 4B live Buyer Request",
    maxBudget: 500_000n,
    maxEtaMinutes: 60n,
    createdAt,
    expires: ExpirationTime.fromDays(1),
  });

  if (result.resumedExistingRfq) {
    throw new ScenarioError(
      "code failure",
      "Fresh rfqId unexpectedly already existed on Arkiv; not a fresh RFQ",
    );
  }

  const receipt = await publicClient.waitForTransactionReceipt({ hash: result.rfqTxHash });
  if (receipt.status !== "success") {
    throw new ScenarioError("Arkiv failure", "RFQ creation transaction reverted");
  }

  // Independent readback: goes straight to Arkiv (attributes + payload), not
  // the in-memory `result`/`result.context` that publishBuyerRequest returned.
  const readBack = await readBackWithRetry(publicClient, result.rfqId);
  const readbackMatches =
    readBack.rfqId === result.rfqId &&
    readBack.buyer.toLowerCase() === buyer.address.toLowerCase() &&
    readBack.status === "open" &&
    readBack.specificationRef === SPECIFICATION_REF &&
    readBack.specificationHash === SPECIFICATION_HASH;
  if (!readbackMatches) {
    throw new ScenarioError(
      "Arkiv failure",
      "Independent RFQ readback does not match the expected rfqId/buyer/status/specification linkage",
    );
  }

  console.log("[SHADOWBID SLICE 4B BUYER REQUEST LIVE]");
  console.log(`arkivNetwork: ${tiramisu.name}`);
  console.log(`arkivNetworkId: ${chainId}`);
  console.log(`buyer: ${buyer.address}`);
  console.log(`buyerBalance: ${formatEther(buyerBalance)}`);
  console.log(`rfqId: ${result.rfqId}`);
  console.log(`rfqEntityKey: ${result.rfqEntityKey}`);
  console.log(`rfqTxHash: ${result.rfqTxHash}`);
  console.log(`specificationRef: ${result.specificationRef}`);
  console.log(`specificationHash: ${result.specificationHash}`);
  console.log(`specificationHashMatchesSwarmEvidence: ${result.specificationHash === SPECIFICATION_HASH}`);
  console.log(`resumedExistingRfq: ${result.resumedExistingRfq}`);
  console.log("--- independent Arkiv readback (payload-backed, not the in-memory result) ---");
  console.log(`readBackRfqId: ${readBack.rfqId}`);
  console.log(`readBackRfqEntityKey: ${readBack.rfqEntityKey}`);
  console.log(`readBackBuyer: ${readBack.buyer}`);
  console.log(`readBackStatus: ${readBack.status}`);
  console.log(`readBackSpecificationRef: ${readBack.specificationRef}`);
  console.log(`readBackSpecificationHash: ${readBack.specificationHash}`);
  console.log(`readBackRfqIdMatches: ${readBack.rfqId === result.rfqId}`);
  console.log(`readBackBuyerMatches: ${readBack.buyer.toLowerCase() === buyer.address.toLowerCase()}`);
  console.log(`readBackStatusOpen: ${readBack.status === "open"}`);
  console.log(`readBackSpecificationRefMatches: ${readBack.specificationRef === SPECIFICATION_REF}`);
  console.log(`readBackSpecificationHashMatches: ${readBack.specificationHash === SPECIFICATION_HASH}`);
  console.log(`readbackMatches: ${readbackMatches}`);
  console.log("swarmUploadUsed: NO (reused real Slice 3B/4B evidence via retry path)");
  console.log("status: PASS");
}

try {
  await run();
} catch (error) {
  console.error("[SHADOWBID SLICE 4B BUYER REQUEST LIVE]");
  console.error("status: FAIL");
  console.error(`failureType: ${error?.failureType ?? "code failure"}`);
  console.error(`message: ${shortMessage(error)}`);
  process.exitCode = 1;
}
