import { readFile } from "node:fs/promises";

import { createPublicClient as createArkivPublicClient } from "@arkiv-network/sdk";
import { tiramisu } from "@arkiv-network/sdk/chains";
import { queryAwardById } from "@shadowbid/shared/arkiv";
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

import { fundAward, readAwardCommitmentInputs } from "../web/src/fund-award.js";

const EXPECTED_CHAIN_ID = 43_113;
const EXPECTED_USDC_DECIMALS = 6;
const ESCROW_ADDRESS = getAddress("0xb8d8ba69db07b957c4ce97220bf8b88e558d0738");
const USDC_ADDRESS = getAddress("0x5425890298aed601595a70AB815c96711a31Bc65");
const DEFAULT_RPC_URL = "https://api.avax-test.network/ext/bc/C/rpc";

// Real 4C Award baseline. Not re-derived: used to cross-check what the
// independent Arkiv reads and the reconstructed commitment come back with.
const AWARD_ID = "0x4e6294db0bac14911a4c16e24852399f4241c74e372b6f83f395feaf66abc530";
const EXPECTED_RFQ_ID = "0x7adb67c16c3901c9e07d64c0ce44164e49b9d729eaf4588c064d674bf254d125";
const EXPECTED_QUOTE_ID = "0xca93a86a837415c483c481ed388298025bbb039cc7fb60515c9e7541eb2d4409";
const EXPECTED_BUYER = getAddress("0x490b01048Af9878434727daF2C3291D2ff8a67B0");
const EXPECTED_SELLER = getAddress("0x4A643d1340F779e5A58a5413eD8908F7e8DC519E");
const EXPECTED_AMOUNT = 350_000n;
const EXPECTED_SPECIFICATION_HASH =
  "0xb9ae219a64126660be6d2a3494f5af2ba24d265f7665fd7d9e27d595b2e54f92";

const FUNDED_STATE = 1;

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
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
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

  // Independent Arkiv evidence: rfqId/quoteId/buyer/seller/amount straight
  // from the real 4C Award entity, cross-checked against the known baseline.
  const page = await queryAwardById(arkivPublicClient, { awardId: AWARD_ID });
  const awardEntity = page.entities[0];
  assertCondition(awardEntity !== undefined, "Arkiv failure", "Real 4C Award could not be read back from Arkiv");
  assertCondition(
    awardEntity.attributes.rfq_id.value === EXPECTED_RFQ_ID,
    "application/encoding failure",
    "Award rfqId does not match the expected 4C RFQ",
  );
  assertCondition(
    awardEntity.attributes.quote_id.value === EXPECTED_QUOTE_ID,
    "application/encoding failure",
    "Award quoteId does not match the expected 4C selected Quote",
  );
  assertCondition(
    sameHex(awardEntity.attributes.buyer.value, EXPECTED_BUYER),
    "application/encoding failure",
    "Award buyer does not match the expected Buyer",
  );
  assertCondition(
    sameHex(awardEntity.attributes.seller.value, EXPECTED_SELLER),
    "application/encoding failure",
    "Award seller does not match the expected Seller",
  );
  assertCondition(
    awardEntity.attributes.amount.value === EXPECTED_AMOUNT,
    "application/encoding failure",
    "Award amount does not match the expected 350000",
  );

  // A + B: reconstruct the commitment and compute termsHash via the one
  // existing shared primitive (buildEscrowCommitmentInput -> deriveTermsHash).
  const commitment = await readAwardCommitmentInputs({
    arkivPublicClient,
    awardId: AWARD_ID,
    token: USDC_ADDRESS,
  });
  assertCondition(
    commitment.procurementId === AWARD_ID,
    "application/encoding failure",
    "procurementId does not equal awardId",
  );
  assertCondition(
    sameHex(commitment.seller, EXPECTED_SELLER) && commitment.amount === EXPECTED_AMOUNT,
    "application/encoding failure",
    "Reconstructed commitment does not match the expected Award",
  );

  const [avaxBalance, usdcDecimals, usdcBalance, allowanceBeforePreflight] = await Promise.all([
    publicClient.getBalance({ address: buyer.address }),
    publicClient.readContract({ address: USDC_ADDRESS, abi: usdcAbi, functionName: "decimals" }),
    publicClient.readContract({
      address: USDC_ADDRESS,
      abi: usdcAbi,
      functionName: "balanceOf",
      args: [buyer.address],
    }),
    publicClient.readContract({
      address: USDC_ADDRESS,
      abi: usdcAbi,
      functionName: "allowance",
      args: [buyer.address, ESCROW_ADDRESS],
    }),
  ]);
  assertCondition(avaxBalance > 0n, "wallet/gas failure", "Buyer has no Fuji AVAX for gas");
  assertCondition(
    usdcDecimals === EXPECTED_USDC_DECIMALS,
    "Fuji RPC/config failure",
    `Fuji USDC reports ${usdcDecimals} decimals`,
  );
  assertCondition(
    usdcBalance >= commitment.amount,
    "USDC allowance/balance failure",
    `Buyer USDC balance ${usdcBalance} is below the Award amount`,
  );

  // C + D + E: preflight escrow check, allowance/approve-if-needed, fund.
  const result = await fundAward({
    publicClient,
    walletClient,
    escrowAddress: ESCROW_ADDRESS,
    escrowAbi,
    usdcAddress: USDC_ADDRESS,
    usdcAbi,
    commitment,
  });

  // F: postconditions, independently from the transaction receipt alone.
  const stored = result.stored;
  const postconditionsHold =
    Number(stored.state) === FUNDED_STATE &&
    sameHex(stored.buyer, EXPECTED_BUYER) &&
    sameHex(stored.seller, EXPECTED_SELLER) &&
    sameHex(stored.token, USDC_ADDRESS) &&
    stored.amount === EXPECTED_AMOUNT &&
    stored.termsHash === commitment.termsHash &&
    commitment.procurementId === AWARD_ID;
  assertCondition(
    postconditionsHold,
    "contract/readback failure",
    "Escrow postconditions do not hold after the independent readback",
  );

  console.log("[SHADOWBID SLICE 4D FUND AWARD LIVE]");
  console.log(`fujiChainId: ${chainId}`);
  console.log(`buyer: ${buyer.address}`);
  console.log(`buyerAvax: ${formatEther(avaxBalance)} AVAX`);
  console.log(`buyerUsdc: ${formatUnits(usdcBalance, EXPECTED_USDC_DECIMALS)} USDC`);
  console.log(`escrowAddress: ${ESCROW_ADDRESS}`);
  console.log(`usdcToken: ${USDC_ADDRESS}`);
  console.log("--- real 4C Award (independent Arkiv readback) ---");
  console.log(`awardId: ${AWARD_ID}`);
  console.log(`rfqId: ${awardEntity.attributes.rfq_id.value}`);
  console.log(`quoteId: ${awardEntity.attributes.quote_id.value}`);
  console.log(`awardBuyer: ${awardEntity.attributes.buyer.value}`);
  console.log(`awardSeller: ${awardEntity.attributes.seller.value}`);
  console.log(`awardAmount: ${awardEntity.attributes.amount.value}`);
  console.log("--- reconstructed commitment (existing buildEscrowCommitmentInput/deriveTermsHash) ---");
  console.log(`procurementId: ${commitment.procurementId}`);
  console.log(`procurementIdEqualsAwardId: ${commitment.procurementId === AWARD_ID}`);
  console.log(`commitmentSeller: ${commitment.seller}`);
  console.log(`commitmentToken: ${commitment.token}`);
  console.log(`commitmentAmount: ${commitment.amount}`);
  console.log(`commitmentDeadline: ${commitment.deadline}`);
  console.log(`computedTermsHash: ${commitment.termsHash}`);
  console.log(`specificationHashUsed: ${EXPECTED_SPECIFICATION_HASH}`);
  console.log("--- funding ---");
  console.log(`allowanceBeforePreflight: ${allowanceBeforePreflight}`);
  console.log(`allowanceBefore: ${result.allowanceBefore ?? "N/A (resumed already-FUNDED escrow)"}`);
  console.log(`approveTxHash: ${result.approveTxHash ?? "NOT_SENT"}`);
  console.log(`allowanceAfter: ${result.allowanceAfter ?? "N/A (resumed already-FUNDED escrow)"}`);
  console.log(`fundingTxHash: ${result.fundingTxHash ?? "NOT_SENT (resumed already-FUNDED escrow)"}`);
  console.log(`resumedAlreadyFunded: ${result.resumedAlreadyFunded}`);
  console.log("--- postconditions (independent escrow readback) ---");
  console.log(`escrowState: FUNDED (${stored.state})`);
  console.log(`storedBuyer: ${stored.buyer}`);
  console.log(`storedSeller: ${stored.seller}`);
  console.log(`storedToken: ${stored.token}`);
  console.log(`storedAmount: ${stored.amount}`);
  console.log(`storedDeadline: ${stored.deadline}`);
  console.log(`storedTermsHash: ${stored.termsHash}`);
  console.log(`storedTermsHashEqualsComputed: ${stored.termsHash === commitment.termsHash}`);
  console.log("deliveryStarted: NO");
  console.log("releaseUsed: NO");
  console.log("refundUsed: NO");
  console.log("status: PASS");
}

try {
  await run();
} catch (error) {
  console.error("[SHADOWBID SLICE 4D FUND AWARD LIVE]");
  console.error("status: FAIL");
  console.error(`failureType: ${error?.failureType ?? "code failure"}`);
  console.error(`message: ${shortMessage(error)}`);
  process.exitCode = 1;
}
