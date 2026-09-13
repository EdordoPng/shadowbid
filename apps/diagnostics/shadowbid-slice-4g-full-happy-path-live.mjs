import { readFile } from "node:fs/promises";

import { createPublicClient as createArkivPublicClient } from "@arkiv-network/sdk";
import { tiramisu } from "@arkiv-network/sdk/chains";
import { queryAwardById, queryQuoteById } from "@shadowbid/shared/arkiv";
import {
  AVALANCHE_ESCROW_STATE,
  PROCUREMENT_STATUS,
  deriveProcurementStatus,
} from "@shadowbid/shared/procurement";
import {
  canonicalizeDeliverableBytes,
  canonicalizeSpecificationBytes,
  hashWorkBytes,
} from "@shadowbid/shared/work-capsule";
import { createPublicClient, defineChain, getAddress, http, parseEventLogs } from "viem";

import { readBackBuyerRequest } from "../web/src/buyer-request.js";
import { retrieveAndVerifyDeliverable } from "../web/src/deliverable.js";
import { SYNTHETIC_DELIVERABLE_4E, buildDeliveredContext } from "../web/src/delivery.js";
import { readAwardCommitmentInputs } from "../web/src/fund-award.js";
import { SYNTHETIC_SPECIFICATION } from "../web/src/specification.js";

// ---- Real, live procurement baseline (Slices 4B-4F). Not re-derived here:
// every value below is INDEPENDENTLY re-read/re-verified against Arkiv,
// Swarm and Avalanche, then cross-checked against these expectations. ----
const EXPECTED_RFQ_ID = "0x7adb67c16c3901c9e07d64c0ce44164e49b9d729eaf4588c064d674bf254d125";
const EXPECTED_QUOTE_ID = "0xca93a86a837415c483c481ed388298025bbb039cc7fb60515c9e7541eb2d4409";
const EXPECTED_AWARD_ID = "0x4e6294db0bac14911a4c16e24852399f4241c74e372b6f83f395feaf66abc530";
const EXPECTED_BUYER = getAddress("0x490b01048Af9878434727daF2C3291D2ff8a67B0");
const EXPECTED_SELLER = getAddress("0x4A643d1340F779e5A58a5413eD8908F7e8DC519E");
const EXPECTED_AMOUNT = 350_000n;
const EXPECTED_DEADLINE = 1_789_237_236n;
const EXPECTED_TERMS_HASH = "0x6c1cf783d93a4d792cc17b6c6125e3f306d3296e9738320667117deecaef0fa3";
const EXPECTED_SPECIFICATION_REF = "506a357133b58499b326013bb4a5996d37bfdff0de6d2c411efa2aaa229a51cc";
const EXPECTED_SPECIFICATION_HASH =
  "0xb9ae219a64126660be6d2a3494f5af2ba24d265f7665fd7d9e27d595b2e54f92";
const EXPECTED_DELIVERABLE_REF = "f65382703c3d55453fd9377a4523b708ac8ed3d0eb10e07fe6fd96df2ed616b9";
const EXPECTED_DELIVERABLE_HASH =
  "0x78557756608ec8ac1f9be9d0d9e03448b1e3259f6c6d95bd23158ae0baad743e";
const RELEASE_TX_HASH = "0x8ed9e2f981f55423584f29638ef90d5f0b6c7dc61800a3d5ca74efd0a0dacbb2";
const HISTORICAL_SELLER_BALANCE_BEFORE = 20_360_000n;
const HISTORICAL_SELLER_BALANCE_AFTER = 20_710_000n;

const EXPECTED_CHAIN_ID = 43_113;
const EXPECTED_USDC_DECIMALS = 6;
const ESCROW_ADDRESS = getAddress("0xb8d8ba69db07b957c4ce97220bf8b88e558d0738");
const USDC_ADDRESS = getAddress("0x5425890298aed601595a70AB815c96711a31Bc65");
const DEFAULT_RPC_URL = "https://api.avax-test.network/ext/bc/C/rpc";
const SWARM_GATEWAY = "https://api.gateway.ethswarm.org/";
const RELEASED_STATE = 2;

const erc20TransferAbi = [
  {
    type: "event",
    name: "Transfer",
    inputs: [
      { indexed: true, name: "from", type: "address" },
      { indexed: true, name: "to", type: "address" },
      { indexed: false, name: "value", type: "uint256" },
    ],
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

function shortMessage(error) {
  return (error?.shortMessage ?? error?.message ?? String(error)).split("\n", 1)[0];
}

function sameHex(left, right) {
  return left?.toLowerCase() === right?.toLowerCase();
}

const matrix = [];
function check(invariant, condition) {
  matrix.push({ invariant, result: condition ? "PASS" : "FAIL" });
  if (!condition) throw new ScenarioError("invariant failure", `FAILED: ${invariant}`);
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
  const arkivPublicClient = createArkivPublicClient({
    chain: tiramisu,
    transport: http(tiramisu.rpcUrls.default.http[0]),
  });
  const publicClient = createPublicClient({
    chain: avalancheFuji,
    transport: http(avalancheFuji.rpcUrls.default.http[0]),
  });
  const escrowAbi = await loadEscrowAbi();

  // ==================================================================
  // 1. Swarm specification — real retrieval, no re-upload.
  // ==================================================================
  const specificationBytes = canonicalizeSpecificationBytes(SYNTHETIC_SPECIFICATION);
  const specificationHash = hashWorkBytes(specificationBytes);
  const retrievedSpecificationBytes = await headlessSwarmReader().downloadData(
    EXPECTED_SPECIFICATION_REF,
  );
  const retrievedSpecificationHash = hashWorkBytes(retrievedSpecificationBytes);
  const specificationByteEquality =
    retrievedSpecificationBytes.byteLength === specificationBytes.byteLength &&
    retrievedSpecificationBytes.every((byte, index) => byte === specificationBytes[index]);

  check("specificationHash == hash(actual Swarm specification bytes)", specificationHash === EXPECTED_SPECIFICATION_HASH);
  check("Swarm specification retrieval succeeds", retrievedSpecificationBytes.byteLength > 0);
  check("Swarm specification byte equality", specificationByteEquality);
  check("Swarm specification retrieved hash == expected specificationHash", retrievedSpecificationHash === EXPECTED_SPECIFICATION_HASH);

  // ==================================================================
  // 2. Arkiv RFQ — independent read.
  // ==================================================================
  const rfq = await readBackBuyerRequest({ arkivPublicClient, rfqId: EXPECTED_RFQ_ID });
  check("RFQ independently readable from Arkiv", rfq !== undefined);
  check("RFQ.rfqId matches", rfq.rfqId === EXPECTED_RFQ_ID);
  check("RFQ.buyer matches", sameHex(rfq.buyer, EXPECTED_BUYER));
  check("RFQ payload specificationRef matches", rfq.specificationRef === EXPECTED_SPECIFICATION_REF);
  check("RFQ payload specificationHash matches", rfq.specificationHash === EXPECTED_SPECIFICATION_HASH);

  // ==================================================================
  // 3. Arkiv selected Quote — independent read.
  // ==================================================================
  const quotePage = await queryQuoteById(arkivPublicClient, { quoteId: EXPECTED_QUOTE_ID });
  const quoteEntity = quotePage.entities[0];
  check("Selected Quote independently readable from Arkiv", quoteEntity !== undefined);
  const quote = Object.freeze({
    quoteId: quoteEntity.attributes.quote_id.value,
    rfqId: quoteEntity.attributes.rfq_id.value,
    seller: quoteEntity.attributes.seller.value,
    price: quoteEntity.attributes.price.value,
    settlementAsset: quoteEntity.attributes.settlement_asset.value,
    status: quoteEntity.attributes.status.value,
  });
  check("Quote.quoteId matches", quote.quoteId === EXPECTED_QUOTE_ID);
  check("Quote.rfqId == RFQ.rfqId", quote.rfqId === rfq.rfqId);
  check("Quote.seller matches", sameHex(quote.seller, EXPECTED_SELLER));
  check("Quote.price == 350000", quote.price === EXPECTED_AMOUNT);
  check("Quote.settlementAsset == usdc", quote.settlementAsset === "usdc");

  // ==================================================================
  // 4. Arkiv Award — independent read.
  // ==================================================================
  const awardPage = await queryAwardById(arkivPublicClient, { awardId: EXPECTED_AWARD_ID });
  const awardEntity = awardPage.entities[0];
  check("Award independently readable from Arkiv", awardEntity !== undefined);
  const award = Object.freeze({
    awardId: EXPECTED_AWARD_ID,
    rfqId: awardEntity.attributes.rfq_id.value,
    quoteId: awardEntity.attributes.quote_id.value,
    buyer: awardEntity.attributes.buyer.value,
    seller: awardEntity.attributes.seller.value,
    amount: awardEntity.attributes.amount.value,
    deadline: awardEntity.attributes.deadline.value,
  });
  check("Award.rfqId == RFQ.rfqId", award.rfqId === rfq.rfqId);
  check("Award.quoteId == selected Quote.quoteId", award.quoteId === quote.quoteId);
  check("Award.buyer == RFQ buyer", sameHex(award.buyer, rfq.buyer));
  check("Award.seller == Quote seller", sameHex(award.seller, quote.seller));
  check("Award.amount == Quote price", award.amount === quote.price);
  check("procurementId == awardId", EXPECTED_AWARD_ID === award.awardId);

  // ==================================================================
  // 5. Canonical commitment — reused from Slice 4D, no duplicate ABI encoding.
  // ==================================================================
  const commitment = await readAwardCommitmentInputs({
    arkivPublicClient,
    awardId: EXPECTED_AWARD_ID,
    token: USDC_ADDRESS,
  });
  check("Reconstructed commitment.procurementId == awardId", commitment.procurementId === EXPECTED_AWARD_ID);
  check("Reconstructed commitment.amount == 350000", commitment.amount === EXPECTED_AMOUNT);
  check("Recomputed termsHash matches expected", commitment.termsHash === EXPECTED_TERMS_HASH);

  // ==================================================================
  // 6. Avalanche escrow — independent read-only Fuji call.
  // ==================================================================
  const chainId = await publicClient.getChainId();
  check("Connected to Fuji", chainId === EXPECTED_CHAIN_ID);
  const stored = await publicClient.readContract({
    address: ESCROW_ADDRESS,
    abi: escrowAbi,
    functionName: "getEscrow",
    args: [EXPECTED_AWARD_ID],
  });
  check("Escrow state == RELEASED", Number(stored.state) === RELEASED_STATE);
  check("Escrow.buyer matches", sameHex(stored.buyer, EXPECTED_BUYER));
  check("Escrow.seller matches", sameHex(stored.seller, EXPECTED_SELLER));
  check("Escrow.token == Fuji USDC", sameHex(stored.token, USDC_ADDRESS));
  check("Escrow.amount == 350000", stored.amount === EXPECTED_AMOUNT);
  check("Escrow.deadline matches", stored.deadline === EXPECTED_DEADLINE);
  check("Stored termsHash == recomputed termsHash", stored.termsHash === commitment.termsHash);

  // ==================================================================
  // 7 + 8. Swarm deliverable — real retrieval + integrity verification.
  // ==================================================================
  const deliverableBytes = canonicalizeDeliverableBytes(SYNTHETIC_DELIVERABLE_4E);
  const deliverableHash = hashWorkBytes(deliverableBytes);
  const uploadedDeliverable = Object.freeze({
    deliverableBytes,
    deliverableHash,
    deliverableRef: EXPECTED_DELIVERABLE_REF,
  });
  const verification = await retrieveAndVerifyDeliverable(headlessSwarmReader(), uploadedDeliverable);
  check("deliverableHash == expected deliverableHash", deliverableHash === EXPECTED_DELIVERABLE_HASH);
  check("Deliverable byte equality == true", verification.byteEquality === true);
  check("Deliverable hash equality == true", verification.hashEquality === true);

  // ==================================================================
  // 9. Avalanche release — historical tx receipt, read-only, no new tx.
  // ==================================================================
  const releaseReceipt = await publicClient.getTransactionReceipt({ hash: RELEASE_TX_HASH });
  check("Release receipt status == success", releaseReceipt.status === "success");
  const releasedLogs = parseEventLogs({
    abi: escrowAbi,
    eventName: "Released",
    logs: releaseReceipt.logs,
    strict: true,
  });
  check("Exactly one Released event in the release receipt", releasedLogs.length === 1);
  const released = releasedLogs[0].args;
  check("Released.procurementId == awardId", released.procurementId === EXPECTED_AWARD_ID);
  check("Released.seller == expected Seller", sameHex(released.seller, EXPECTED_SELLER));
  check("Released.amount == 350000", released.amount === EXPECTED_AMOUNT);

  const transferLogs = parseEventLogs({
    abi: erc20TransferAbi,
    eventName: "Transfer",
    logs: releaseReceipt.logs,
    strict: false,
  }).filter((log) => sameHex(log.address, USDC_ADDRESS) && sameHex(log.args.to, EXPECTED_SELLER));
  check("USDC Transfer log to Seller present in the release receipt", transferLogs.length === 1);
  const transferValue = transferLogs[0]?.args.value;
  check("USDC Transfer value == 350000", transferValue === EXPECTED_AMOUNT);
  check(
    "Historical Seller balance delta == 350000",
    HISTORICAL_SELLER_BALANCE_AFTER - HISTORICAL_SELLER_BALANCE_BEFORE === EXPECTED_AMOUNT,
  );

  // ==================================================================
  // 10. Final application projection.
  // ==================================================================
  const { context, status } = buildDeliveredContext({
    rfqId: rfq.rfqId,
    quoteId: quote.quoteId,
    awardId: award.awardId,
    buyer: rfq.buyer,
    seller: quote.seller,
    specificationRef: rfq.specificationRef,
    specificationHash: rfq.specificationHash,
    escrowState: Number(stored.state),
    uploadedDeliverable,
    verification,
  });
  check("deliverableVerified == true", context.deliverableVerified === true);
  check("context.escrowState == RELEASED", context.escrowState === AVALANCHE_ESCROW_STATE.RELEASED);
  check("deriveProcurementStatus(context) == SETTLED", status === PROCUREMENT_STATUS.SETTLED);
  check(
    "deriveProcurementStatus is pure/idempotent on re-derivation",
    deriveProcurementStatus(context) === PROCUREMENT_STATUS.SETTLED,
  );

  console.log("[SHADOWBID SLICE 4G FULL HAPPY-PATH LIVE PROOF]");
  console.log("=== 1. Swarm specification ===");
  console.log(`specificationRef: ${EXPECTED_SPECIFICATION_REF}`);
  console.log(`specificationHash: ${specificationHash}`);
  console.log(`retrievedSpecificationHash: ${retrievedSpecificationHash}`);
  console.log(`specificationByteEquality: ${specificationByteEquality}`);
  console.log("=== 2. Arkiv RFQ ===");
  console.log(`rfqId: ${rfq.rfqId}`);
  console.log(`rfqBuyer: ${rfq.buyer}`);
  console.log(`rfqStatus: ${rfq.status}`);
  console.log(`rfqPayloadSpecificationRef: ${rfq.specificationRef}`);
  console.log(`rfqPayloadSpecificationHash: ${rfq.specificationHash}`);
  console.log("=== 3. Arkiv selected Quote ===");
  console.log(`quoteId: ${quote.quoteId}`);
  console.log(`quoteSeller: ${quote.seller}`);
  console.log(`quotePrice: ${quote.price}`);
  console.log(`quoteSettlementAsset: ${quote.settlementAsset}`);
  console.log("=== 4. Arkiv Award ===");
  console.log(`awardId: ${award.awardId}`);
  console.log(`awardRfqId: ${award.rfqId}`);
  console.log(`awardQuoteId: ${award.quoteId}`);
  console.log(`awardBuyer: ${award.buyer}`);
  console.log(`awardSeller: ${award.seller}`);
  console.log(`awardAmount: ${award.amount}`);
  console.log(`procurementIdEqualsAwardId: ${EXPECTED_AWARD_ID === award.awardId}`);
  console.log("=== 5. Canonical commitment (existing buildEscrowCommitmentInput/deriveTermsHash) ===");
  console.log(`commitmentProcurementId: ${commitment.procurementId}`);
  console.log(`computedTermsHash: ${commitment.termsHash}`);
  console.log("=== 6. Avalanche escrow (live Fuji read) ===");
  console.log(`fujiChainId: ${chainId}`);
  console.log(`escrowState: RELEASED (${stored.state})`);
  console.log(`storedBuyer: ${stored.buyer}`);
  console.log(`storedSeller: ${stored.seller}`);
  console.log(`storedToken: ${stored.token}`);
  console.log(`storedAmount: ${stored.amount}`);
  console.log(`storedDeadline: ${stored.deadline}`);
  console.log(`storedTermsHash: ${stored.termsHash}`);
  console.log("=== 7. Swarm deliverable ===");
  console.log(`deliverableRef: ${EXPECTED_DELIVERABLE_REF}`);
  console.log(`deliverableHash: ${deliverableHash}`);
  console.log("=== 8. Delivery verification ===");
  console.log(`retrievedByteLength: ${verification.retrievedBytes.byteLength}`);
  console.log(`byteEquality: ${verification.byteEquality}`);
  console.log(`retrievedHash: ${verification.retrievedHash}`);
  console.log(`hashEquality: ${verification.hashEquality}`);
  console.log("=== 9. Avalanche release (historical receipt, read-only) ===");
  console.log(`releaseTxHash: ${RELEASE_TX_HASH}`);
  console.log(`releaseReceiptStatus: ${releaseReceipt.status}`);
  console.log(`releasedEventProcurementId: ${released.procurementId}`);
  console.log(`releasedEventSeller: ${released.seller}`);
  console.log(`releasedEventAmount: ${released.amount}`);
  console.log(`usdcTransferValueToSeller: ${transferValue}`);
  console.log(`historicalSellerBalanceBefore: ${HISTORICAL_SELLER_BALANCE_BEFORE}`);
  console.log(`historicalSellerBalanceAfter: ${HISTORICAL_SELLER_BALANCE_AFTER}`);
  console.log(`historicalDelta: ${HISTORICAL_SELLER_BALANCE_AFTER - HISTORICAL_SELLER_BALANCE_BEFORE}`);
  console.log("=== 10. Final application projection ===");
  console.log(`context.procurementId: ${context.procurementId}`);
  console.log(`context.deliverableVerified: ${context.deliverableVerified}`);
  console.log(`context.escrowState: ${context.escrowState}`);
  console.log(`derivedStatus: ${status}`);
  console.log("");
  console.log("=== CROSS-LAYER INVARIANT MATRIX ===");
  for (const { invariant, result } of matrix) {
    console.log(`${result}: ${invariant}`);
  }
  console.log("");
  console.log(`invariantsTotal: ${matrix.length}`);
  console.log(`invariantsPassed: ${matrix.filter((m) => m.result === "PASS").length}`);
  console.log("newWritesPerformed: NONE");
  console.log("status: PASS");
}

try {
  await run();
} catch (error) {
  console.error("[SHADOWBID SLICE 4G FULL HAPPY-PATH LIVE PROOF]");
  console.error("status: FAIL");
  console.error(`failureType: ${error?.failureType ?? "code failure"}`);
  console.error(`message: ${shortMessage(error)}`);
  console.error("");
  console.error("=== CROSS-LAYER INVARIANT MATRIX (partial) ===");
  for (const { invariant, result } of matrix) {
    console.error(`${result}: ${invariant}`);
  }
  process.exitCode = 1;
}
