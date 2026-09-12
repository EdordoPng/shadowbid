import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

import {
  createPublicClient,
  createWalletClient,
  defineChain,
  formatEther,
  getAddress,
  http,
  parseEventLogs,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { snapshotAward } from "@shadowbid/shared/arkiv";
import {
  buildEscrowCommitmentInput,
  hashSpecification,
} from "@shadowbid/shared/commitment";

const EXPECTED_CHAIN_ID = 43_113;
const EXPECTED_USDC_DECIMALS = 6;
const DEFAULT_RPC_URL = "https://api.avax-test.network/ext/bc/C/rpc";
const ESCROW_ADDRESS = getAddress("0xb8d8ba69db07b957c4ce97220bf8b88e558d0738");
const USDC_ADDRESS = getAddress("0x5425890298aed601595a70AB815c96711a31Bc65");
const EXPECTED_BUYER = getAddress("0x490b01048Af9878434727daF2C3291D2ff8a67B0");
const EXPECTED_SELLER = getAddress("0x4A643d1340F779e5A58a5413eD8908F7e8DC519E");
const EXPECTED_CALLER = getAddress("0xEAAD2aaC9cdFE74F45F95C74E87b981561BcEbaC");
const AMOUNT = 250_000n;
const DEADLINE_LEAD_SECONDS = 300n;
const POLL_INTERVAL_MS = 5_000;
const SPECIFICATION = "ShadowBid Slice 2E refund specification v1";

const State = Object.freeze({ NONE: 0, FUNDED: 1, REFUNDED: 3 });

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

function newApplicationId() {
  return `0x${randomBytes(32).toString("hex")}`;
}

function loadActor(label, addressVariable, privateKeyVariable, expectedAddress) {
  const configuredAddress = process.env[addressVariable];
  const privateKey = process.env[privateKeyVariable];
  if (!configuredAddress || !privateKey) {
    throw new ScenarioError(
      "wallet/gas failure",
      `${addressVariable} and ${privateKeyVariable} are required for ${label}`,
    );
  }

  let account;
  try {
    account = privateKeyToAccount(privateKey);
  } catch {
    throw new ScenarioError("wallet/gas failure", `${label} private key is invalid`);
  }

  assertCondition(
    sameHex(configuredAddress, expectedAddress) && sameHex(account.address, expectedAddress),
    "wallet/gas failure",
    `${label} configuration does not match the expected address`,
  );
  return account;
}

function loadConfiguration() {
  assertCondition(
    Number(process.env.AVALANCHE_CHAIN_ID ?? EXPECTED_CHAIN_ID) === EXPECTED_CHAIN_ID,
    "Fuji RPC/config failure",
    "Configured Avalanche chain ID is not Fuji",
  );
  assertCondition(
    Number(process.env.USDC_DECIMALS ?? EXPECTED_USDC_DECIMALS) ===
      EXPECTED_USDC_DECIMALS,
    "Fuji RPC/config failure",
    "Configured USDC decimals are not 6",
  );
  assertCondition(
    sameHex(process.env.USDC_ADDRESS ?? USDC_ADDRESS, USDC_ADDRESS),
    "Fuji RPC/config failure",
    "Configured USDC does not match Fuji test USDC",
  );

  return Object.freeze({
    buyer: loadActor(
      "Buyer",
      "SHADOWBID_BUYER_ADDRESS",
      "SHADOWBID_BUYER_PRIVATE_KEY",
      EXPECTED_BUYER,
    ),
    caller: loadActor(
      "Seller B refund caller",
      "SHADOWBID_SELLER_B_ADDRESS",
      "SHADOWBID_SELLER_B_PRIVATE_KEY",
      EXPECTED_CALLER,
    ),
  });
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

async function readUsdc(publicClient, functionName, args = [], blockNumber) {
  return publicClient.readContract({
    address: USDC_ADDRESS,
    abi: usdcAbi,
    functionName,
    args,
    ...(blockNumber === undefined ? {} : { blockNumber }),
  });
}

async function readEscrow(publicClient, escrowAbi, procurementId, blockNumber) {
  return publicClient.readContract({
    address: ESCROW_ADDRESS,
    abi: escrowAbi,
    functionName: "getEscrow",
    args: [procurementId],
    ...(blockNumber === undefined ? {} : { blockNumber }),
  });
}

function commercialFieldsMatch(stored, commitment, buyer) {
  return (
    sameHex(stored.buyer, buyer) &&
    sameHex(stored.seller, commitment.seller) &&
    sameHex(stored.token, commitment.token) &&
    stored.amount === commitment.amount &&
    stored.termsHash === commitment.termsHash &&
    stored.deadline === commitment.deadline
  );
}

async function waitForDeadline(publicClient, deadline) {
  while (true) {
    const block = await publicClient.getBlock();
    if (block.timestamp >= deadline) {
      return Object.freeze({ blockNumber: block.number, timestamp: block.timestamp });
    }
    await delay(POLL_INTERVAL_MS);
  }
}

async function run() {
  const actors = loadConfiguration();
  const escrowAbi = await loadEscrowAbi();
  const transport = http(avalancheFuji.rpcUrls.default.http[0]);
  const publicClient = createPublicClient({ chain: avalancheFuji, transport });
  const buyerWallet = createWalletClient({
    account: actors.buyer,
    chain: avalancheFuji,
    transport,
  });
  const callerWallet = createWalletClient({
    account: actors.caller,
    chain: avalancheFuji,
    transport,
  });

  let preflight;
  try {
    const [chainId, code, buyerAvax, callerAvax, buyerUsdc, decimals, escrowUsdc, block] =
      await Promise.all([
        publicClient.getChainId(),
        publicClient.getCode({ address: ESCROW_ADDRESS }),
        publicClient.getBalance({ address: EXPECTED_BUYER }),
        publicClient.getBalance({ address: EXPECTED_CALLER }),
        readUsdc(publicClient, "balanceOf", [EXPECTED_BUYER]),
        readUsdc(publicClient, "decimals"),
        readUsdc(publicClient, "balanceOf", [ESCROW_ADDRESS]),
        publicClient.getBlock(),
      ]);
    preflight = { chainId, code, buyerAvax, callerAvax, buyerUsdc, decimals, escrowUsdc, block };
  } catch (error) {
    throw new ScenarioError("Fuji RPC/config failure", shortMessage(error));
  }

  assertCondition(
    preflight.chainId === EXPECTED_CHAIN_ID,
    "Fuji RPC/config failure",
    `Fuji RPC returned chain ID ${preflight.chainId}`,
  );
  assertCondition(
    preflight.code && preflight.code !== "0x",
    "contract/readback failure",
    "Existing escrow bytecode is absent",
  );
  assertCondition(
    preflight.buyerAvax > 0n && preflight.callerAvax > 0n,
    "wallet/gas failure",
    "Buyer or non-Buyer refund caller has no Fuji AVAX",
  );
  assertCondition(
    preflight.buyerUsdc >= AMOUNT,
    "USDC allowance/balance failure",
    `Buyer USDC balance ${preflight.buyerUsdc} is below ${AMOUNT}`,
  );
  assertCondition(
    preflight.decimals === EXPECTED_USDC_DECIMALS,
    "Fuji RPC/config failure",
    `Fuji USDC reports ${preflight.decimals} decimals`,
  );
  assertCondition(
    preflight.escrowUsdc === 0n,
    "USDC allowance/balance failure",
    "Existing escrow has a non-zero USDC balance before this isolated scenario",
  );

  const rfqId = newApplicationId();
  const quoteId = newApplicationId();
  const awardId = newApplicationId();
  const deadline = preflight.block.timestamp + DEADLINE_LEAD_SECONDS;
  const award = snapshotAward({
    awardId,
    buyer: EXPECTED_BUYER,
    deadline,
    selectedQuote: {
      rfqId,
      quoteId,
      seller: EXPECTED_SELLER,
      price: AMOUNT,
      settlementAsset: "usdc",
    },
  });
  const specificationHash = hashSpecification(SPECIFICATION);
  const commitment = buildEscrowCommitmentInput({
    award,
    token: USDC_ADDRESS,
    specificationHash,
  });
  const emptyEscrow = await readEscrow(publicClient, escrowAbi, commitment.procurementId);
  assertCondition(
    Number(emptyEscrow.state) === State.NONE,
    "contract/readback failure",
    "Fresh procurementId unexpectedly already exists",
  );

  const allowanceBefore = await readUsdc(publicClient, "allowance", [
    EXPECTED_BUYER,
    ESCROW_ADDRESS,
  ]);
  let approveTxHash;
  let allowanceAfter = allowanceBefore;
  if (allowanceBefore < AMOUNT) {
    try {
      const approval = await publicClient.simulateContract({
        account: actors.buyer,
        address: USDC_ADDRESS,
        abi: usdcAbi,
        functionName: "approve",
        args: [ESCROW_ADDRESS, AMOUNT],
      });
      assertCondition(
        approval.result === true,
        "USDC allowance/balance failure",
        "USDC approve simulation did not return true",
      );
      approveTxHash = await buyerWallet.writeContract(approval.request);
      const approvalReceipt = await publicClient.waitForTransactionReceipt({ hash: approveTxHash });
      assertCondition(
        approvalReceipt.status === "success",
        "USDC allowance/balance failure",
        "USDC approval reverted",
      );
      allowanceAfter = await readUsdc(
        publicClient,
        "allowance",
        [EXPECTED_BUYER, ESCROW_ADDRESS],
        approvalReceipt.blockNumber,
      );
    } catch (error) {
      if (error instanceof ScenarioError) throw error;
      throw new ScenarioError("USDC allowance/balance failure", shortMessage(error));
    }
  }
  assertCondition(
    allowanceAfter >= AMOUNT,
    "USDC allowance/balance failure",
    "Escrow allowance does not cover the fresh commitment",
  );

  const [buyerBeforeFund, callerBeforeFund, sellerBeforeFund, escrowBeforeFund] =
    await Promise.all([
      readUsdc(publicClient, "balanceOf", [EXPECTED_BUYER]),
      readUsdc(publicClient, "balanceOf", [EXPECTED_CALLER]),
      readUsdc(publicClient, "balanceOf", [EXPECTED_SELLER]),
      readUsdc(publicClient, "balanceOf", [ESCROW_ADDRESS]),
    ]);

  let fundingTxHash;
  let fundingReceipt;
  try {
    const funding = await publicClient.simulateContract({
      account: actors.buyer,
      address: ESCROW_ADDRESS,
      abi: escrowAbi,
      functionName: "fund",
      args: [
        commitment.procurementId,
        commitment.seller,
        commitment.token,
        commitment.amount,
        commitment.termsHash,
        commitment.deadline,
      ],
    });
    fundingTxHash = await buyerWallet.writeContract(funding.request);
    fundingReceipt = await publicClient.waitForTransactionReceipt({ hash: fundingTxHash });
  } catch (error) {
    throw new ScenarioError("contract/funding failure", shortMessage(error));
  }
  assertCondition(
    fundingReceipt.status === "success",
    "contract/funding failure",
    "Funding transaction reverted",
  );

  const [storedFunded, buyerAfterFund, escrowAfterFund, fundedBlock] = await Promise.all([
    readEscrow(publicClient, escrowAbi, commitment.procurementId, fundingReceipt.blockNumber),
    readUsdc(publicClient, "balanceOf", [EXPECTED_BUYER], fundingReceipt.blockNumber),
    readUsdc(publicClient, "balanceOf", [ESCROW_ADDRESS], fundingReceipt.blockNumber),
    publicClient.getBlock({ blockNumber: fundingReceipt.blockNumber }),
  ]);
  assertCondition(
    Number(storedFunded.state) === State.FUNDED &&
      commercialFieldsMatch(storedFunded, commitment, EXPECTED_BUYER),
    "contract/readback failure",
    "Funded escrow readback does not match the fresh commitment",
  );
  assertCondition(
    buyerBeforeFund - buyerAfterFund === AMOUNT &&
      escrowAfterFund - escrowBeforeFund === AMOUNT,
    "USDC allowance/balance failure",
    "Funding USDC balance deltas do not equal the commitment amount",
  );
  assertCondition(
    fundedBlock.timestamp < deadline,
    "deadline verification failure",
    "Funding confirmed after the refund deadline",
  );

  let earlyRefundResult;
  try {
    await publicClient.simulateContract({
      account: actors.caller,
      address: ESCROW_ADDRESS,
      abi: escrowAbi,
      functionName: "refundAfterDeadline",
      args: [commitment.procurementId],
    });
  } catch (error) {
    const details = `${error?.shortMessage ?? ""}\n${error?.message ?? ""}`;
    assertCondition(
      details.includes("InvalidDeadline"),
      "deadline verification failure",
      `Early refund simulation failed unexpectedly: ${shortMessage(error)}`,
    );
    earlyRefundResult = "REVERTED_INVALID_DEADLINE";
  }
  assertCondition(
    earlyRefundResult === "REVERTED_INVALID_DEADLINE",
    "deadline verification failure",
    "Early refund simulation unexpectedly succeeded",
  );

  console.log(
    `[SHADOWBID SLICE 2E WAIT] fundedAt=${fundedBlock.timestamp} deadline=${deadline}`,
  );
  const boundary = await waitForDeadline(publicClient, deadline);

  const [buyerBeforeRefund, callerBeforeRefund, sellerBeforeRefund, escrowBeforeRefund] =
    await Promise.all([
      readUsdc(publicClient, "balanceOf", [EXPECTED_BUYER]),
      readUsdc(publicClient, "balanceOf", [EXPECTED_CALLER]),
      readUsdc(publicClient, "balanceOf", [EXPECTED_SELLER]),
      readUsdc(publicClient, "balanceOf", [ESCROW_ADDRESS]),
    ]);

  let refundTxHash;
  let refundReceipt;
  try {
    const refund = await publicClient.simulateContract({
      account: actors.caller,
      address: ESCROW_ADDRESS,
      abi: escrowAbi,
      functionName: "refundAfterDeadline",
      args: [commitment.procurementId],
    });
    refundTxHash = await callerWallet.writeContract(refund.request);
    refundReceipt = await publicClient.waitForTransactionReceipt({ hash: refundTxHash });
  } catch (error) {
    const type = shortMessage(error).toLowerCase().includes("insufficient funds")
      ? "wallet/gas failure"
      : "contract/refund failure";
    throw new ScenarioError(type, shortMessage(error));
  }
  assertCondition(
    refundReceipt.status === "success",
    "contract/refund failure",
    "Refund transaction reverted",
  );

  const [storedRefunded, buyerAfterRefund, callerAfterRefund, sellerAfterRefund, escrowAfterRefund] =
    await Promise.all([
      readEscrow(publicClient, escrowAbi, commitment.procurementId, refundReceipt.blockNumber),
      readUsdc(publicClient, "balanceOf", [EXPECTED_BUYER], refundReceipt.blockNumber),
      readUsdc(publicClient, "balanceOf", [EXPECTED_CALLER], refundReceipt.blockNumber),
      readUsdc(publicClient, "balanceOf", [EXPECTED_SELLER], refundReceipt.blockNumber),
      readUsdc(publicClient, "balanceOf", [ESCROW_ADDRESS], refundReceipt.blockNumber),
    ]);
  const refundedLogs = parseEventLogs({
    abi: escrowAbi,
    eventName: "Refunded",
    logs: refundReceipt.logs,
    strict: true,
  });
  assertCondition(
    refundedLogs.length === 1,
    "contract/refund failure",
    `Expected one Refunded event, received ${refundedLogs.length}`,
  );
  const refunded = refundedLogs[0].args;

  assertCondition(
    Number(storedRefunded.state) === State.REFUNDED &&
      commercialFieldsMatch(storedRefunded, commitment, EXPECTED_BUYER),
    "contract/readback failure",
    "Refunded escrow state or immutable fields are incorrect",
  );
  assertCondition(
    buyerAfterRefund - buyerBeforeRefund === AMOUNT &&
      buyerAfterRefund === buyerBeforeFund,
    "USDC allowance/balance failure",
    "Buyer did not receive the exact funded amount back",
  );
  assertCondition(
    callerAfterRefund === callerBeforeRefund && sellerAfterRefund === sellerBeforeRefund,
    "USDC allowance/balance failure",
    "Refund caller or Seller received USDC",
  );
  assertCondition(
    escrowBeforeRefund - escrowAfterRefund === AMOUNT && escrowAfterRefund === 0n,
    "USDC allowance/balance failure",
    "Escrow did not return the exact amount and reach zero",
  );
  assertCondition(
    refunded.procurementId === commitment.procurementId &&
      sameHex(refunded.buyer, EXPECTED_BUYER) &&
      sameHex(refunded.caller, EXPECTED_CALLER) &&
      sameHex(refunded.token, USDC_ADDRESS) &&
      refunded.amount === AMOUNT,
    "contract/refund failure",
    "Refunded event does not match the fresh commitment",
  );
  assertCondition(
    callerBeforeFund === callerBeforeRefund && sellerBeforeFund === sellerBeforeRefund,
    "USDC allowance/balance failure",
    "Caller or Seller balance changed during funding/wait",
  );

  console.log("[SHADOWBID SLICE 2E LIVE]");
  console.log(`network: ${avalancheFuji.name}`);
  console.log(`chainId: ${preflight.chainId}`);
  console.log(`escrow: ${ESCROW_ADDRESS}`);
  console.log(`escrowBytecode: PRESENT`);
  console.log(`commitmentSource: LOCAL_CANONICAL_AWARD_FIXTURE`);
  console.log(`rfqId: ${rfqId}`);
  console.log(`quoteId: ${quoteId}`);
  console.log(`awardId: ${awardId}`);
  console.log(`procurementId: ${commitment.procurementId}`);
  console.log(`caller: ${EXPECTED_CALLER}`);
  console.log(`seller: ${EXPECTED_SELLER}`);
  console.log(`amount: ${AMOUNT}`);
  console.log(`specificationHash: ${specificationHash}`);
  console.log(`termsHash: ${commitment.termsHash}`);
  console.log(`deadline: ${deadline}`);
  console.log(`buyerAvaxPreflight: ${formatEther(preflight.buyerAvax)} AVAX`);
  console.log(`callerAvaxPreflight: ${formatEther(preflight.callerAvax)} AVAX`);
  console.log(`buyerUsdcPreflight: ${preflight.buyerUsdc}`);
  console.log(`usdcDecimals: ${preflight.decimals}`);
  console.log(`allowanceBefore: ${allowanceBefore}`);
  console.log(`approveTxHash: ${approveTxHash ?? "NOT_SENT_EXISTING_ALLOWANCE"}`);
  console.log(`allowanceAfter: ${allowanceAfter}`);
  console.log(`fundingTxHash: ${fundingTxHash}`);
  console.log(`stateAfterFunding: FUNDED (${storedFunded.state})`);
  console.log(`buyerUsdcBeforeFunding: ${buyerBeforeFund}`);
  console.log(`buyerUsdcAfterFunding: ${buyerAfterFund}`);
  console.log(`escrowUsdcBeforeFunding: ${escrowBeforeFund}`);
  console.log(`escrowUsdcAfterFunding: ${escrowAfterFund}`);
  console.log(`earlyRefundSimulation: ${earlyRefundResult}`);
  console.log(`fundingBlockTimestamp: ${fundedBlock.timestamp}`);
  console.log(`boundaryBlockNumber: ${boundary.blockNumber}`);
  console.log(`boundaryBlockTimestamp: ${boundary.timestamp}`);
  console.log(`refundTxHash: ${refundTxHash}`);
  console.log(`refundReceiptStatus: ${refundReceipt.status}`);
  console.log(`refundedEventProcurementId: ${refunded.procurementId}`);
  console.log(`refundedEventBuyer: ${refunded.buyer}`);
  console.log(`refundedEventCaller: ${refunded.caller}`);
  console.log(`refundedEventToken: ${refunded.token}`);
  console.log(`refundedEventAmount: ${refunded.amount}`);
  console.log(`buyerUsdcBeforeRefund: ${buyerBeforeRefund}`);
  console.log(`buyerUsdcAfterRefund: ${buyerAfterRefund}`);
  console.log(`buyerUsdcRefundDelta: ${buyerAfterRefund - buyerBeforeRefund}`);
  console.log(`buyerUsdcWholeScenarioDelta: ${buyerAfterRefund - buyerBeforeFund}`);
  console.log(`callerUsdcBeforeRefund: ${callerBeforeRefund}`);
  console.log(`callerUsdcAfterRefund: ${callerAfterRefund}`);
  console.log(`callerUsdcDelta: ${callerAfterRefund - callerBeforeRefund}`);
  console.log(`sellerUsdcBeforeRefund: ${sellerBeforeRefund}`);
  console.log(`sellerUsdcAfterRefund: ${sellerAfterRefund}`);
  console.log(`sellerUsdcDelta: ${sellerAfterRefund - sellerBeforeRefund}`);
  console.log(`escrowUsdcBeforeRefund: ${escrowBeforeRefund}`);
  console.log(`escrowUsdcAfterRefund: ${escrowAfterRefund}`);
  console.log(`escrowUsdcRefundDelta: ${escrowAfterRefund - escrowBeforeRefund}`);
  console.log(`finalState: REFUNDED (${storedRefunded.state})`);
  console.log(`storedBuyer: ${storedRefunded.buyer}`);
  console.log(`storedSeller: ${storedRefunded.seller}`);
  console.log(`storedToken: ${storedRefunded.token}`);
  console.log(`storedAmount: ${storedRefunded.amount}`);
  console.log(`storedTermsHash: ${storedRefunded.termsHash}`);
  console.log(`storedDeadline: ${storedRefunded.deadline}`);
  console.log(`commercialFieldsUnchanged: PASS`);
  console.log(`releaseUsed: NO`);
  console.log(`status: PASS`);
}

try {
  await run();
} catch (error) {
  console.error("[SHADOWBID SLICE 2E LIVE]");
  console.error("status: FAIL");
  console.error(`failureType: ${error?.failureType ?? "contract/refund failure"}`);
  console.error(`message: ${shortMessage(error)}`);
  process.exitCode = 1;
}
