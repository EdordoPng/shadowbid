import { createPublicClient, defineChain, getAddress, http } from "viem";
import { readFile } from "node:fs/promises";

import { canonicalizeDeliverableBytes, hashWorkBytes } from "@shadowbid/shared/work-capsule";
import { AVALANCHE_ESCROW_STATE } from "@shadowbid/shared/procurement";

import { retrieveAndVerifyDeliverable } from "../web/src/deliverable.js";
import { SYNTHETIC_DELIVERABLE_4E, buildDeliveredContext } from "../web/src/delivery.js";

// Real, non-encrypted Swarm content is retrievable from any public Bee
// gateway by reference alone — no wallet/identity needed for reads, only for
// the Seller's paid upload. Same default gateway @snaha/swarm-id itself uses.
const SWARM_GATEWAY = "https://api.gateway.ethswarm.org/";

const EXPECTED_CHAIN_ID = 43_113;
const ESCROW_ADDRESS = getAddress("0xb8d8ba69db07b957c4ce97220bf8b88e558d0738");
const USDC_ADDRESS = getAddress("0x5425890298aed601595a70AB815c96711a31Bc65");
const DEFAULT_RPC_URL = "https://api.avax-test.network/ext/bc/C/rpc";

// Real, live procurement baseline from Slices 4B-4D.
const RFQ_ID = "0x7adb67c16c3901c9e07d64c0ce44164e49b9d729eaf4588c064d674bf254d125";
const QUOTE_ID = "0xca93a86a837415c483c481ed388298025bbb039cc7fb60515c9e7541eb2d4409";
const AWARD_ID = "0x4e6294db0bac14911a4c16e24852399f4241c74e372b6f83f395feaf66abc530";
const BUYER = getAddress("0x490b01048Af9878434727daF2C3291D2ff8a67B0");
const SELLER = getAddress("0x4A643d1340F779e5A58a5413eD8908F7e8DC519E");
const SPECIFICATION_REF = "506a357133b58499b326013bb4a5996d37bfdff0de6d2c411efa2aaa229a51cc";
const SPECIFICATION_HASH = "0xb9ae219a64126660be6d2a3494f5af2ba24d265f7665fd7d9e27d595b2e54f92";

// The deliverableRef reported back after the real fresh browser upload
// (apps/web/delivery-smoke.html). Not re-uploaded here.
const DELIVERABLE_REF = "f65382703c3d55453fd9377a4523b708ac8ed3d0eb10e07fe6fd96df2ed616b9";

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

/** Real headless Buyer-side Swarm reader: a plain HTTP GET against a public
 * Bee gateway. No wallet, no browser, no local/fake fallback. */
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

async function run() {
  // The exact fixture bytes are known independently (authored for this
  // slice), so the expected hash is computed here, not trusted blindly.
  const deliverableBytes = canonicalizeDeliverableBytes(SYNTHETIC_DELIVERABLE_4E);
  const deliverableHash = hashWorkBytes(deliverableBytes);
  const uploadedDeliverable = Object.freeze({
    deliverableBytes,
    deliverableHash,
    deliverableRef: DELIVERABLE_REF,
  });

  // Buyer-side real, headless Swarm retrieval + verification, reusing the
  // existing unchanged Slice 3 retrieveAndVerifyDeliverable.
  const verification = await retrieveAndVerifyDeliverable(headlessSwarmReader(), uploadedDeliverable);
  assertCondition(verification.byteEquality === true, "integrity failure", "Byte equality is not true");
  assertCondition(verification.hashEquality === true, "integrity failure", "Hash equality is not true");

  // Independent Avalanche read: confirm the escrow is still FUNDED, purely
  // read-only, no wallet required.
  const publicClient = createPublicClient({
    chain: avalancheFuji,
    transport: http(avalancheFuji.rpcUrls.default.http[0]),
  });
  const escrowAbi = await loadEscrowAbi();
  const chainId = await publicClient.getChainId();
  assertCondition(chainId === EXPECTED_CHAIN_ID, "Fuji RPC/config failure", `Unexpected chain ID ${chainId}`);

  const stored = await publicClient.readContract({
    address: ESCROW_ADDRESS,
    abi: escrowAbi,
    functionName: "getEscrow",
    args: [AWARD_ID],
  });
  const escrowState = Number(stored.state);
  assertCondition(
    escrowState === AVALANCHE_ESCROW_STATE.FUNDED,
    "contract/readback failure",
    `Escrow state is ${escrowState}, not FUNDED`,
  );
  assertCondition(
    sameHex(stored.buyer, BUYER) && sameHex(stored.seller, SELLER) && sameHex(stored.token, USDC_ADDRESS),
    "contract/readback failure",
    "Escrow commercial fields changed unexpectedly during delivery",
  );

  // Join the verified delivery with the real Award/RFQ identifiers.
  const { context, status } = buildDeliveredContext({
    rfqId: RFQ_ID,
    quoteId: QUOTE_ID,
    awardId: AWARD_ID,
    buyer: BUYER,
    seller: SELLER,
    specificationRef: SPECIFICATION_REF,
    specificationHash: SPECIFICATION_HASH,
    escrowState,
    uploadedDeliverable,
    verification,
  });

  console.log("[SHADOWBID SLICE 4E DELIVERY LIVE]");
  console.log("--- Seller upload (real, via apps/web/delivery-smoke.html) ---");
  console.log(`deliverableByteLength: ${deliverableBytes.byteLength}`);
  console.log(`deliverableHash: ${deliverableHash}`);
  console.log(`deliverableRef: ${DELIVERABLE_REF}`);
  console.log("--- Buyer retrieval (real, headless, public Swarm gateway) ---");
  console.log(`swarmGateway: ${SWARM_GATEWAY}`);
  console.log(`retrievedByteLength: ${verification.retrievedBytes.byteLength}`);
  console.log(`retrievedHash: ${verification.retrievedHash}`);
  console.log(`byteEquality: ${verification.byteEquality}`);
  console.log(`hashEquality: ${verification.hashEquality}`);
  console.log("--- Avalanche (independent, read-only) ---");
  console.log(`fujiChainId: ${chainId}`);
  console.log(`escrowState: FUNDED (${escrowState})`);
  console.log(`escrowBuyer: ${stored.buyer}`);
  console.log(`escrowSeller: ${stored.seller}`);
  console.log(`escrowToken: ${stored.token}`);
  console.log(`escrowAmount: ${stored.amount}`);
  console.log(`escrowTermsHash: ${stored.termsHash}`);
  console.log("--- ProcurementContext (Slice 4A, joined) ---");
  console.log(`context.rfqId: ${context.rfqId}`);
  console.log(`context.quoteId: ${context.quoteId}`);
  console.log(`context.awardId: ${context.awardId}`);
  console.log(`context.procurementId: ${context.procurementId}`);
  console.log(`procurementIdEqualsAwardId: ${context.procurementId === context.awardId}`);
  console.log(`context.buyer: ${context.buyer}`);
  console.log(`context.seller: ${context.seller}`);
  console.log(`context.specificationRef: ${context.specificationRef}`);
  console.log(`context.specificationHash: ${context.specificationHash}`);
  console.log(`context.deliverableRef: ${context.deliverableRef}`);
  console.log(`context.deliverableHash: ${context.deliverableHash}`);
  console.log(`context.deliverableVerified: ${context.deliverableVerified}`);
  console.log(`context.escrowState: ${context.escrowState}`);
  console.log(`derivedStatus: ${status}`);
  console.log("arkivDeliveryEntityCreated: NO");
  console.log("releaseUsed: NO");
  console.log("status: PASS");
}

try {
  await run();
} catch (error) {
  console.error("[SHADOWBID SLICE 4E DELIVERY LIVE]");
  console.error("status: FAIL");
  console.error(`failureType: ${error?.failureType ?? "code failure"}`);
  console.error(`message: ${shortMessage(error)}`);
  process.exitCode = 1;
}
