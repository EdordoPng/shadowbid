import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  createPublicClient,
  createWalletClient,
  defineChain,
  formatEther,
  formatUnits,
  getAddress,
  http,
  parseEventLogs,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import {
  assertCanonicalBytes32,
  buildEscrowCommitmentInput,
} from "@shadowbid/shared/commitment";

const execFileAsync = promisify(execFile);

const EXPECTED_CHAIN_ID = 43_113;
const EXPECTED_USDC_DECIMALS = 6;
const EXPECTED_USDC = getAddress("0x5425890298aed601595a70AB815c96711a31Bc65");
const ESCROW_ADDRESS = getAddress("0xb8d8ba69db07b957c4ce97220bf8b88e558d0738");
const EXPECTED_AWARD_AMOUNT = 350_000n;
const DEFAULT_RPC_URL = "https://api.avax-test.network/ext/bc/C/rpc";

// Real Swarm specification hash, proven byte-equal in Slice 3B/3D. Not derived here on purpose.
const REAL_SWARM_SPECIFICATION_HASH = assertCanonicalBytes32(
  "0xb9ae219a64126660be6d2a3494f5af2ba24d265f7665fd7d9e27d595b2e54f92",
  "specificationHash",
);

const State = Object.freeze({ NONE: 0, FUNDED: 1, RELEASED: 2, REFUNDED: 3 });

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

function loadConfiguration() {
  const required = ["SHADOWBID_BUYER_ADDRESS", "SHADOWBID_BUYER_PRIVATE_KEY"];
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new ScenarioError("wallet/gas failure", `Missing configuration: ${missing.join(", ")}`);
  }

  const configuredChainId = Number(process.env.AVALANCHE_CHAIN_ID ?? EXPECTED_CHAIN_ID);
  const configuredDecimals = Number(
    process.env.USDC_DECIMALS ?? EXPECTED_USDC_DECIMALS,
  );
  let configuredUsdc;
  let account;

  try {
    configuredUsdc = getAddress(process.env.USDC_ADDRESS ?? EXPECTED_USDC);
    account = privateKeyToAccount(process.env.SHADOWBID_BUYER_PRIVATE_KEY);
  } catch {
    throw new ScenarioError("wallet/gas failure", "Buyer key or Fuji token address is invalid");
  }

  assertCondition(
    configuredChainId === EXPECTED_CHAIN_ID,
    "Fuji RPC/config failure",
    `Configured chain ID ${configuredChainId} does not equal ${EXPECTED_CHAIN_ID}`,
  );
  assertCondition(
    configuredDecimals === EXPECTED_USDC_DECIMALS,
    "Fuji RPC/config failure",
    `Configured USDC decimals ${configuredDecimals} do not equal ${EXPECTED_USDC_DECIMALS}`,
  );
  assertCondition(
    sameHex(configuredUsdc, EXPECTED_USDC),
    "Fuji RPC/config failure",
    `Configured USDC is not the required Fuji test token`,
  );
  assertCondition(
    sameHex(account.address, process.env.SHADOWBID_BUYER_ADDRESS),
    "wallet/gas failure",
    "Buyer private key does not match SHADOWBID_BUYER_ADDRESS",
  );

  return Object.freeze({ account, rpcUrl: avalancheFuji.rpcUrls.default.http[0] });
}

async function loadEscrowArtifact() {
  const artifactUrl = new URL(
    "../../packages/contracts/artifacts/contracts/ShadowBidEscrow.sol/ShadowBidEscrow.json",
    import.meta.url,
  );

  try {
    const artifact = JSON.parse(await readFile(artifactUrl, "utf8"));
    return artifact;
  } catch (error) {
    if (error instanceof ScenarioError) throw error;
    throw new ScenarioError(
      "contract/deployment failure",
      "ShadowBidEscrow artifact is unavailable; run the contract compile check first",
    );
  }
}

async function readUsdc(publicClient, functionName, args = [], blockNumber) {
  return publicClient.readContract({
    address: EXPECTED_USDC,
    abi: usdcAbi,
    functionName,
    args,
    ...(blockNumber === undefined ? {} : { blockNumber }),
  });
}

async function runFujiPreflight(publicClient, buyerAddress) {
  try {
    const [chainId, code, avaxBalance, decimals, usdcBalance] = await Promise.all([
      publicClient.getChainId(),
      publicClient.getCode({ address: ESCROW_ADDRESS }),
      publicClient.getBalance({ address: buyerAddress }),
      readUsdc(publicClient, "decimals"),
      readUsdc(publicClient, "balanceOf", [buyerAddress]),
    ]);

    assertCondition(
      chainId === EXPECTED_CHAIN_ID,
      "Fuji RPC/config failure",
      `Fuji RPC returned chain ID ${chainId}`,
    );
    assertCondition(
      code && code !== "0x",
      "contract/deployment failure",
      "Existing ShadowBidEscrow has no bytecode at the configured address",
    );
    assertCondition(
      avaxBalance > 0n,
      "wallet/gas failure",
      "Buyer has no Fuji AVAX for gas",
    );
    assertCondition(
      decimals === EXPECTED_USDC_DECIMALS,
      "Fuji RPC/config failure",
      `Fuji USDC reports ${decimals} decimals`,
    );
    assertCondition(
      usdcBalance >= EXPECTED_AWARD_AMOUNT,
      "USDC allowance/balance failure",
      `Buyer USDC balance ${usdcBalance} is below ${EXPECTED_AWARD_AMOUNT}`,
    );

    return Object.freeze({ chainId, avaxBalance, decimals, usdcBalance });
  } catch (error) {
    if (error instanceof ScenarioError) throw error;
    throw new ScenarioError("Fuji RPC/config failure", shortMessage(error));
  }
}

function parseDiagnosticOutput(stdout) {
  const values = {};
  for (const line of stdout.split(/\r?\n/)) {
    const separator = line.indexOf(": ");
    if (separator > 0) values[line.slice(0, separator)] = line.slice(separator + 2);
  }
  return values;
}

async function createFreshArkivAward() {
  const diagnosticPath = new URL("./arkiv-slice-1d-award-live.mjs", import.meta.url);
  let stdout;

  try {
    ({ stdout } = await execFileAsync(process.execPath, [fileURLToPath(diagnosticPath)], {
      env: process.env,
      maxBuffer: 1024 * 1024,
    }));
  } catch (error) {
    throw new ScenarioError(
      "Arkiv failure",
      `Slice 1D fresh Award creation failed: ${shortMessage(error?.stderr || error)}`,
    );
  }

  const output = parseDiagnosticOutput(stdout);
  assertCondition(output.status === "PASS", "Arkiv failure", "Slice 1D did not report PASS");

  const award = Object.freeze({
    awardId: output.awardId,
    rfqId: output.awardRfqId,
    quoteId: output.awardQuoteId,
    buyer: getAddress(output.awardBuyer),
    seller: getAddress(output.awardSeller),
    amount: BigInt(output.awardAmount),
    settlementAsset: output.awardSettlementAsset,
    deadline: BigInt(output.awardDeadline),
  });

  assertCondition(
    output.awardStatus === "pending_funding" && award.settlementAsset === "usdc",
    "Arkiv failure",
    "Fresh Award status or settlement asset is invalid",
  );
  assertCondition(
    award.amount === EXPECTED_AWARD_AMOUNT,
    "Arkiv failure",
    `Fresh Award amount ${award.amount} is not the canonical Quote amount`,
  );
  assertCondition(
    award.deadline > BigInt(Math.floor(Date.now() / 1_000)) + 600n,
    "Arkiv failure",
    "Fresh Award deadline is not safely in the future",
  );

  return Object.freeze({ output, award });
}

async function requireSuccessfulReceipt(publicClient, hash, failureType, label) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  assertCondition(receipt.status === "success", failureType, `${label} transaction reverted`);
  return receipt;
}

async function run() {
  const configuration = loadConfiguration();
  const artifact = await loadEscrowArtifact();
  const transport = http(configuration.rpcUrl);
  const publicClient = createPublicClient({ chain: avalancheFuji, transport });
  const walletClient = createWalletClient({
    account: configuration.account,
    chain: avalancheFuji,
    transport,
  });

  const preflight = await runFujiPreflight(publicClient, configuration.account.address);
  const { output: arkiv, award } = await createFreshArkivAward();
  assertCondition(
    sameHex(award.buyer, configuration.account.address),
    "application/encoding failure",
    "Arkiv Award Buyer does not match the Fuji transaction signer",
  );

  let commitment;
  try {
    commitment = buildEscrowCommitmentInput({
      award,
      token: EXPECTED_USDC,
      specificationHash: REAL_SWARM_SPECIFICATION_HASH,
    });
  } catch (error) {
    throw new ScenarioError("application/encoding failure", shortMessage(error));
  }
  assertCondition(
    commitment.procurementId === award.awardId,
    "application/encoding failure",
    "procurementId does not equal the fresh awardId",
  );

  const preExisting = await publicClient.readContract({
    address: ESCROW_ADDRESS,
    abi: artifact.abi,
    functionName: "getEscrow",
    args: [commitment.procurementId],
  });
  assertCondition(
    Number(preExisting.state) === State.NONE,
    "contract/readback failure",
    "Fresh procurementId unexpectedly already exists in the escrow",
  );

  const allowanceBefore = await readUsdc(publicClient, "allowance", [
    configuration.account.address,
    ESCROW_ADDRESS,
  ]);
  let approveTxHash;
  let allowanceAfter = allowanceBefore;

  if (allowanceBefore < commitment.amount) {
    try {
      const simulation = await publicClient.simulateContract({
        account: configuration.account,
        address: EXPECTED_USDC,
        abi: usdcAbi,
        functionName: "approve",
        args: [ESCROW_ADDRESS, commitment.amount],
      });
      assertCondition(
        simulation.result === true,
        "USDC allowance/balance failure",
        "USDC approve simulation did not return true",
      );
      approveTxHash = await walletClient.writeContract(simulation.request);
      const approveReceipt = await requireSuccessfulReceipt(
        publicClient,
        approveTxHash,
        "USDC allowance/balance failure",
        "Approval",
      );
      allowanceAfter = await readUsdc(
        publicClient,
        "allowance",
        [configuration.account.address, ESCROW_ADDRESS],
        approveReceipt.blockNumber,
      );
    } catch (error) {
      if (error instanceof ScenarioError) throw error;
      throw new ScenarioError("USDC allowance/balance failure", shortMessage(error));
    }
  }

  assertCondition(
    allowanceAfter >= commitment.amount,
    "USDC allowance/balance failure",
    "Escrow allowance does not cover the Award amount",
  );

  const [buyerBeforeFund, contractBeforeFund] = await Promise.all([
    readUsdc(publicClient, "balanceOf", [configuration.account.address]),
    readUsdc(publicClient, "balanceOf", [ESCROW_ADDRESS]),
  ]);

  let fundingTxHash;
  let fundingReceipt;
  try {
    const simulation = await publicClient.simulateContract({
      account: configuration.account,
      address: ESCROW_ADDRESS,
      abi: artifact.abi,
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
    fundingTxHash = await walletClient.writeContract(simulation.request);
    fundingReceipt = await requireSuccessfulReceipt(
      publicClient,
      fundingTxHash,
      "contract/funding failure",
      "Funding",
    );
  } catch (error) {
    if (error instanceof ScenarioError) throw error;
    const message = shortMessage(error).toLowerCase();
    const type = message.includes("allowance") || message.includes("balance")
      ? "USDC allowance/balance failure"
      : "contract/funding failure";
    throw new ScenarioError(type, shortMessage(error));
  }

  const [stored, buyerAfterFund, contractAfterFund] = await Promise.all([
    publicClient.readContract({
      address: ESCROW_ADDRESS,
      abi: artifact.abi,
      functionName: "getEscrow",
      args: [commitment.procurementId],
      blockNumber: fundingReceipt.blockNumber,
    }),
    readUsdc(
      publicClient,
      "balanceOf",
      [configuration.account.address],
      fundingReceipt.blockNumber,
    ),
    readUsdc(publicClient, "balanceOf", [ESCROW_ADDRESS], fundingReceipt.blockNumber),
  ]);
  const fundedLogs = parseEventLogs({
    abi: artifact.abi,
    eventName: "Funded",
    logs: fundingReceipt.logs,
    strict: true,
  });
  assertCondition(
    fundedLogs.length === 1,
    "contract/funding failure",
    `Expected one Funded event, received ${fundedLogs.length}`,
  );
  const fundedEvent = fundedLogs[0].args;

  const readbackMatches =
    Number(stored.state) === State.FUNDED &&
    sameHex(stored.buyer, award.buyer) &&
    sameHex(stored.seller, award.seller) &&
    sameHex(stored.token, EXPECTED_USDC) &&
    stored.amount === award.amount &&
    stored.termsHash === commitment.termsHash &&
    stored.deadline === award.deadline;
  assertCondition(
    readbackMatches,
    "contract/readback failure",
    "Escrow readback does not match the fresh Award commitment",
  );

  const eventMatches =
    fundedEvent.procurementId === award.awardId &&
    sameHex(fundedEvent.buyer, award.buyer) &&
    sameHex(fundedEvent.seller, award.seller) &&
    sameHex(fundedEvent.token, EXPECTED_USDC) &&
    fundedEvent.amount === award.amount &&
    fundedEvent.termsHash === commitment.termsHash &&
    fundedEvent.deadline === award.deadline;
  assertCondition(
    eventMatches,
    "contract/funding failure",
    "Funded event does not match the fresh Award commitment",
  );
  assertCondition(
    buyerBeforeFund - buyerAfterFund === award.amount &&
      contractAfterFund - contractBeforeFund === award.amount,
    "USDC allowance/balance failure",
    "Buyer or escrow USDC balance delta is not the Award amount",
  );

  console.log("[SHADOWBID SLICE 3E CROSS-LAYER LIVE]");
  console.log(`arkivNetwork: ${arkiv.network}`);
  console.log(`arkivNetworkId: ${arkiv.networkId}`);
  console.log(`rfqId: ${arkiv.rfqId}`);
  console.log(`rfqEntityKey: ${arkiv.rfqEntityKey}`);
  console.log(`rfqTxHash: ${arkiv.rfqTxHash}`);
  console.log(`quoteId: ${arkiv.quoteId}`);
  console.log(`quoteEntityKey: ${arkiv.quoteEntityKey}`);
  console.log(`quoteTxHash: ${arkiv.quoteTxHash}`);
  console.log(`awardId: ${award.awardId}`);
  console.log(`awardEntityKey: ${arkiv.awardEntityKey}`);
  console.log(`awardTxHash: ${arkiv.awardTxHash}`);
  console.log(`awardBuyer: ${award.buyer}`);
  console.log(`awardSeller: ${award.seller}`);
  console.log(`awardAmount: ${award.amount}`);
  console.log(`awardAsset: ${award.settlementAsset}`);
  console.log(`awardDeadline: ${award.deadline}`);
  console.log(`awardStatus: ${arkiv.awardStatus}`);
  console.log(`procurementId: ${commitment.procurementId}`);
  console.log(`procurementIdEqualsAwardId: ${commitment.procurementId === award.awardId}`);
  console.log(`specificationHash: ${REAL_SWARM_SPECIFICATION_HASH}`);
  console.log(`specificationHashSource: SLICE_3B_REAL_SWARM (unchanged, not re-derived)`);
  console.log(`termsHash: ${commitment.termsHash}`);
  console.log(`fujiChainId: ${preflight.chainId}`);
  console.log(`buyer: ${configuration.account.address}`);
  console.log(`buyerAvaxPreflightWei: ${preflight.avaxBalance}`);
  console.log(`buyerAvaxPreflight: ${formatEther(preflight.avaxBalance)} AVAX`);
  console.log(`buyerUsdcPreflight: ${preflight.usdcBalance}`);
  console.log(`buyerUsdcPreflightFormatted: ${formatUnits(preflight.usdcBalance, 6)} USDC`);
  console.log(`usdcDecimals: ${preflight.decimals}`);
  console.log(`usdcToken: ${EXPECTED_USDC}`);
  console.log(`escrowAddress: ${ESCROW_ADDRESS}`);
  console.log("escrowNewlyDeployed: NO (existing ShadowBidEscrow reused)");
  console.log(`preExistingState: NONE (${preExisting.state})`);
  console.log(`allowanceBefore: ${allowanceBefore}`);
  console.log(`approveTxHash: ${approveTxHash ?? "NOT_SENT_EXISTING_ALLOWANCE"}`);
  console.log(`allowanceAfter: ${allowanceAfter}`);
  console.log(`fundingTxHash: ${fundingTxHash}`);
  console.log(`fundedEventProcurementId: ${fundedEvent.procurementId}`);
  console.log(`fundedEventBuyer: ${fundedEvent.buyer}`);
  console.log(`fundedEventSeller: ${fundedEvent.seller}`);
  console.log(`fundedEventToken: ${fundedEvent.token}`);
  console.log(`fundedEventAmount: ${fundedEvent.amount}`);
  console.log(`fundedEventTermsHash: ${fundedEvent.termsHash}`);
  console.log(`fundedEventDeadline: ${fundedEvent.deadline}`);
  console.log(`escrowState: FUNDED (${stored.state})`);
  console.log(`escrowBuyer: ${stored.buyer}`);
  console.log(`escrowSeller: ${stored.seller}`);
  console.log(`escrowToken: ${stored.token}`);
  console.log(`escrowAmount: ${stored.amount}`);
  console.log(`escrowTermsHash: ${stored.termsHash}`);
  console.log(`escrowDeadline: ${stored.deadline}`);
  console.log(`storedTermsHashEqualsComputed: ${stored.termsHash === commitment.termsHash}`);
  console.log(`buyerUsdcBeforeFund: ${buyerBeforeFund}`);
  console.log(`buyerUsdcAfterFund: ${buyerAfterFund}`);
  console.log(`buyerUsdcDelta: ${buyerBeforeFund - buyerAfterFund}`);
  console.log(`contractUsdcBeforeFund: ${contractBeforeFund}`);
  console.log(`contractUsdcAfterFund: ${contractAfterFund}`);
  console.log(`contractUsdcDelta: ${contractAfterFund - contractBeforeFund}`);
  console.log("crossLayerAssertions: PASS");
  console.log("releaseUsed: NO");
  console.log("refundUsed: NO");
  console.log("status: PASS");
}

try {
  await run();
} catch (error) {
  console.error("[SHADOWBID SLICE 3E CROSS-LAYER LIVE]");
  console.error("status: FAIL");
  console.error(`failureType: ${error?.failureType ?? "application/encoding failure"}`);
  console.error(`message: ${shortMessage(error)}`);
  process.exitCode = 1;
}
