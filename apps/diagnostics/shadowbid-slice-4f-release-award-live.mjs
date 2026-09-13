import { readFile } from "node:fs/promises";

import { createPublicClient as createArkivPublicClient } from "@arkiv-network/sdk";
import { tiramisu } from "@arkiv-network/sdk/chains";
import { AVALANCHE_ESCROW_STATE } from "@shadowbid/shared/procurement";
import { canonicalizeDeliverableBytes, hashWorkBytes } from "@shadowbid/shared/work-capsule";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  formatEther,
  formatUnits,
  getAddress,
  http,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { retrieveAndVerifyDeliverable } from "../web/src/deliverable.js";
import { SYNTHETIC_DELIVERABLE_4E, buildDeliveredContext } from "../web/src/delivery.js";
import { readAwardCommitmentInputs } from "../web/src/fund-award.js";
import { releaseAward } from "../web/src/release-award.js";

const EXPECTED_CHAIN_ID = 43_113;
const EXPECTED_USDC_DECIMALS = 6;
const ESCROW_ADDRESS = getAddress("0xb8d8ba69db07b957c4ce97220bf8b88e558d0738");
const USDC_ADDRESS = getAddress("0x5425890298aed601595a70AB815c96711a31Bc65");
const DEFAULT_RPC_URL = "https://api.avax-test.network/ext/bc/C/rpc";
const SWARM_GATEWAY = "https://api.gateway.ethswarm.org/";

// Real, live procurement baseline from Slices 4B-4E.
const AWARD_ID = "0x4e6294db0bac14911a4c16e24852399f4241c74e372b6f83f395feaf66abc530";
const EXPECTED_RFQ_ID = "0x7adb67c16c3901c9e07d64c0ce44164e49b9d729eaf4588c064d674bf254d125";
const EXPECTED_QUOTE_ID = "0xca93a86a837415c483c481ed388298025bbb039cc7fb60515c9e7541eb2d4409";
const EXPECTED_BUYER = getAddress("0x490b01048Af9878434727daF2C3291D2ff8a67B0");
const EXPECTED_SELLER = getAddress("0x4A643d1340F779e5A58a5413eD8908F7e8DC519E");
const EXPECTED_AMOUNT = 350_000n;
const EXPECTED_TERMS_HASH = "0x6c1cf783d93a4d792cc17b6c6125e3f306d3296e9738320667117deecaef0fa3";
const DELIVERABLE_REF = "f65382703c3d55453fd9377a4523b708ac8ed3d0eb10e07fe6fd96df2ed616b9";

const RELEASED_STATE = 2;

const usdcAbi = [
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint8" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
];

const avalancheFuji = defineChain({
  id: EXPECTED_CHAIN_ID,
  name: "Avalanche Fuji",
  nativeCurrency: { name: "Avalanche", symbol: "AVAX", decimals: 18 },
  rpcUrls: { default: { http: [process.env.AVALANCHE_RPC_URL ?? DEFAULT_RPC_URL] } },
  testnet: true,
});

class ScenarioError extends Error {
  constructor(failureType, message) {
    super(message);
    this.failureType = failureType;
  }
}

function assertCondition(condition, failureType, message) {
  if (!condition) throw new ScenarioError(failureType, message);
}

function sameHex(left, right) {
  return left?.toLowerCase() === right?.toLowerCase();
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
  if (!sameHex(account.address, address)) {
    throw new ScenarioError(
      "wallet/gas failure",
      "Buyer private key does not match SHADOWBID_BUYER_ADDRESS",
    );
  }
  return account;
}

async function loadEscrowAbi() {
  const artifactUrl = new URL(
    "../../packages/contracts/artifacts/contracts/ShadowBidEscrow.sol/ShadowBidEscrow.json",
    import.meta.url,
  );
  try {
    return JSON.parse(await readFile(artifactUrl, "utf8")).abi;
  } catch {
    throw new ScenarioError(
      "contract/readback failure",
      "ShadowBidEscrow artifact is unavailable; run the contract compile check first",
    );
  }
}

function headlessSwarmReader() {
  return {
    async downloadData(reference) {
      const response = await fetch(`${SWARM_GATEWAY}bytes/${reference}`);
      if (!response.ok) {
        throw new ScenarioError(
          "Swarm/network failure",
          `Swarm gateway returned HTTP ${response.status} for reference ${reference}`,
        );
      }
      return new Uint8Array(await response.arrayBuffer());
    },
  };
}

async function run() {
  const buyer = loadBuyer();
  const rpcUrl = avalancheFuji.rpcUrls.default.http[0];
  const publicClient = createPublicClient({ chain: avalancheFuji, transport: http(rpcUrl) });
  const walletClient = createWalletClient({ account: buyer, chain: avalancheFuji, transport: http(rpcUrl) });
  const escrowAbi = await loadEscrowAbi();
  const arkivPublicClient = createArkivPublicClient({
    chain: tiramisu,
    transport: http(tiramisu.rpcUrls.default.http[0]),
  });

  const chainId = await publicClient.getChainId();
  assertCondition(chainId === EXPECTED_CHAIN_ID, "Fuji RPC/config failure", `Unexpected chain ID ${chainId}`);
  assertCondition(sameHex(buyer.address, EXPECTED_BUYER), "wallet/gas failure", "Signer is not the expected Buyer");

  // A: reconstruct the commitment from the real Award/RFQ (reused from Slice 4D, no new ABI encoding).
  const commitment = await readAwardCommitmentInputs({
    arkivPublicClient,
    awardId: AWARD_ID,
    token: USDC_ADDRESS,
  });
  assertCondition(commitment.procurementId === AWARD_ID, "application/encoding failure", "procurementId does not equal awardId");
  assertCondition(sameHex(commitment.seller, EXPECTED_SELLER), "application/encoding failure", "Reconstructed seller mismatch");
  assertCondition(commitment.amount === EXPECTED_AMOUNT, "application/encoding failure", "Reconstructed amount mismatch");
  assertCondition(commitment.termsHash === EXPECTED_TERMS_HASH, "application/encoding failure", "Reconstructed termsHash mismatch");

  // Safety re-verification of delivery integrity, immediately before release
  // (Slice 4E's real evidence, reused: no re-upload, real headless retrieval).
  const deliverableBytes = canonicalizeDeliverableBytes(SYNTHETIC_DELIVERABLE_4E);
  const deliverableHash = hashWorkBytes(deliverableBytes);
  const uploadedDeliverable = Object.freeze({ deliverableBytes, deliverableHash, deliverableRef: DELIVERABLE_REF });
  const verification = await retrieveAndVerifyDeliverable(headlessSwarmReader(), uploadedDeliverable);
  assertCondition(verification.byteEquality === true, "integrity failure", "Delivery byte equality is not true");
  assertCondition(verification.hashEquality === true, "integrity failure", "Delivery hash equality is not true");

  const { context: deliveredContext } = buildDeliveredContext({
    rfqId: EXPECTED_RFQ_ID,
    quoteId: EXPECTED_QUOTE_ID,
    awardId: AWARD_ID,
    buyer: EXPECTED_BUYER,
    seller: EXPECTED_SELLER,
    escrowState: AVALANCHE_ESCROW_STATE.FUNDED,
    uploadedDeliverable,
    verification,
  });

  // Explicit pre-release preflight, purely for evidence (releaseAward performs
  // its own authoritative read internally regardless of this one).
  const [preflightEscrow, sellerUsdcPreflight, usdcDecimals] = await Promise.all([
    publicClient.readContract({ address: ESCROW_ADDRESS, abi: escrowAbi, functionName: "getEscrow", args: [AWARD_ID] }),
    publicClient.readContract({ address: USDC_ADDRESS, abi: usdcAbi, functionName: "balanceOf", args: [EXPECTED_SELLER] }),
    publicClient.readContract({ address: USDC_ADDRESS, abi: usdcAbi, functionName: "decimals" }),
  ]);
  assertCondition(usdcDecimals === EXPECTED_USDC_DECIMALS, "Fuji RPC/config failure", "Unexpected USDC decimals");

  // C + D + E: preflight guard, release, Seller balance delta, postconditions.
  const result = await releaseAward({
    publicClient,
    walletClient,
    escrowAddress: ESCROW_ADDRESS,
    escrowAbi,
    usdcAddress: USDC_ADDRESS,
    usdcAbi,
    commitment,
    context: deliveredContext,
  });

  const stored = result.stored;
  const postconditionsHold =
    Number(stored.state) === RELEASED_STATE &&
    sameHex(stored.buyer, EXPECTED_BUYER) &&
    sameHex(stored.seller, EXPECTED_SELLER) &&
    sameHex(stored.token, USDC_ADDRESS) &&
    stored.amount === EXPECTED_AMOUNT &&
    stored.termsHash === EXPECTED_TERMS_HASH &&
    commitment.procurementId === AWARD_ID;
  assertCondition(postconditionsHold, "contract/readback failure", "Escrow postconditions do not hold after release");

  if (!result.resumedAlreadyReleased) {
    assertCondition(
      result.balanceDelta === EXPECTED_AMOUNT,
      "USDC balance failure",
      `Seller balance delta ${result.balanceDelta} does not equal ${EXPECTED_AMOUNT}`,
    );
  }

  console.log("[SHADOWBID SLICE 4F RELEASE AWARD LIVE]");
  console.log(`fujiChainId: ${chainId}`);
  console.log(`buyer: ${buyer.address}`);
  console.log(`seller: ${EXPECTED_SELLER}`);
  console.log(`escrowAddress: ${ESCROW_ADDRESS}`);
  console.log(`usdcToken: ${USDC_ADDRESS}`);
  console.log("--- reconstructed commitment (Slice 4D readAwardCommitmentInputs, reused) ---");
  console.log(`procurementId: ${commitment.procurementId}`);
  console.log(`procurementIdEqualsAwardId: ${commitment.procurementId === AWARD_ID}`);
  console.log(`commitmentAmount: ${commitment.amount}`);
  console.log(`commitmentTermsHash: ${commitment.termsHash}`);
  console.log("--- delivery safety re-verification (Slice 4E, real headless retrieval, no re-upload) ---");
  console.log(`deliverableRef: ${DELIVERABLE_REF}`);
  console.log(`deliverableHash: ${deliverableHash}`);
  console.log(`byteEquality: ${verification.byteEquality}`);
  console.log(`hashEquality: ${verification.hashEquality}`);
  console.log(`deliverableVerified: ${deliveredContext.deliverableVerified}`);
  console.log("--- pre-release ---");
  console.log(`preflightEscrowState: ${Number(preflightEscrow.state)}`);
  console.log(`preflightStoredTermsHash: ${preflightEscrow.termsHash}`);
  console.log(`sellerUsdcBefore: ${sellerUsdcPreflight} (${formatUnits(sellerUsdcPreflight, EXPECTED_USDC_DECIMALS)} USDC)`);
  console.log("--- release ---");
  console.log(`resumedAlreadyReleased: ${result.resumedAlreadyReleased}`);
  console.log(`releaseTxHash: ${result.releaseTxHash ?? "NOT_SENT (resumed already-RELEASED escrow)"}`);
  console.log(`sellerBalanceBefore: ${result.sellerBalanceBefore ?? "N/A (resumed)"}`);
  console.log(`sellerBalanceAfter: ${result.sellerBalanceAfter ?? "N/A (resumed)"}`);
  console.log(`balanceDelta: ${result.balanceDelta ?? "N/A (resumed)"}`);
  console.log(`balanceDeltaEqualsAmount: ${result.resumedAlreadyReleased ? "N/A (resumed)" : result.balanceDelta === EXPECTED_AMOUNT}`);
  console.log("--- post-release (independent escrow readback) ---");
  console.log(`escrowState: RELEASED (${stored.state})`);
  console.log(`storedBuyer: ${stored.buyer}`);
  console.log(`storedSeller: ${stored.seller}`);
  console.log(`storedToken: ${stored.token}`);
  console.log(`storedAmount: ${stored.amount}`);
  console.log(`storedTermsHash: ${stored.termsHash}`);
  console.log(`storedTermsHashUnchanged: ${stored.termsHash === EXPECTED_TERMS_HASH}`);
  console.log(`derivedStatus: ${result.status}`);
  console.log("refundUsed: NO");
  console.log("secondReleaseAttempted: NO");
  console.log("status: PASS");
}

try {
  await run();
} catch (error) {
  console.error("[SHADOWBID SLICE 4F RELEASE AWARD LIVE]");
  console.error("status: FAIL");
  console.error(`failureType: ${error?.failureType ?? "code failure"}`);
  console.error(`message: ${shortMessage(error)}`);
  process.exitCode = 1;
}
