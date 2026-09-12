import { readFile } from "node:fs/promises";

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

const EXPECTED_CHAIN_ID = 43_113;
const DEFAULT_RPC_URL = "https://api.avax-test.network/ext/bc/C/rpc";
const PROCUREMENT_ID = "0x045f94580335d76cc5ac1619028b743d04f75171ebab20ebc052ba243a914293";
const ESCROW_ADDRESS = getAddress("0xb8d8ba69db07b957c4ce97220bf8b88e558d0738");
const USDC_ADDRESS = getAddress("0x5425890298aed601595a70AB815c96711a31Bc65");
const EXPECTED_BUYER = getAddress("0x490b01048Af9878434727daF2C3291D2ff8a67B0");
const EXPECTED_SELLER = getAddress("0x4A643d1340F779e5A58a5413eD8908F7e8DC519E");
const EXPECTED_AMOUNT = 350_000n;

const State = Object.freeze({ FUNDED: 1, RELEASED: 2 });

const usdcAbi = [
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
  const privateKey = process.env.SHADOWBID_BUYER_PRIVATE_KEY;
  const configuredAddress = process.env.SHADOWBID_BUYER_ADDRESS;
  if (!privateKey || !configuredAddress) {
    throw new ScenarioError(
      "wallet/gas failure",
      "SHADOWBID_BUYER_PRIVATE_KEY and SHADOWBID_BUYER_ADDRESS are required",
    );
  }

  let account;
  try {
    account = privateKeyToAccount(privateKey);
  } catch {
    throw new ScenarioError("wallet/gas failure", "Buyer private key is invalid");
  }

  assertCondition(
    sameHex(configuredAddress, EXPECTED_BUYER) && sameHex(account.address, EXPECTED_BUYER),
    "wallet/gas failure",
    "Configured Buyer does not match the funded escrow Buyer",
  );
  assertCondition(
    Number(process.env.AVALANCHE_CHAIN_ID ?? EXPECTED_CHAIN_ID) === EXPECTED_CHAIN_ID,
    "Fuji RPC/config failure",
    "Configured Avalanche chain ID is not Fuji",
  );
  assertCondition(
    sameHex(process.env.USDC_ADDRESS ?? USDC_ADDRESS, USDC_ADDRESS),
    "Fuji RPC/config failure",
    "Configured USDC does not match Fuji test USDC",
  );

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

async function readUsdcBalance(publicClient, address, blockNumber) {
  return publicClient.readContract({
    address: USDC_ADDRESS,
    abi: usdcAbi,
    functionName: "balanceOf",
    args: [address],
    ...(blockNumber === undefined ? {} : { blockNumber }),
  });
}

function commercialFieldsMatch(before, after) {
  return (
    sameHex(after.buyer, before.buyer) &&
    sameHex(after.seller, before.seller) &&
    sameHex(after.token, before.token) &&
    after.amount === before.amount &&
    after.termsHash === before.termsHash &&
    after.deadline === before.deadline
  );
}

async function verifyNonBuyerCannotRelease(publicClient, escrowAbi) {
  try {
    await publicClient.simulateContract({
      account: EXPECTED_SELLER,
      address: ESCROW_ADDRESS,
      abi: escrowAbi,
      functionName: "release",
      args: [PROCUREMENT_ID],
    });
  } catch (error) {
    const details = `${error?.shortMessage ?? ""}\n${error?.message ?? ""}`;
    assertCondition(
      details.includes("OnlyBuyer"),
      "ownership verification failure",
      `Non-Buyer simulation failed for an unexpected reason: ${shortMessage(error)}`,
    );
    return "REVERTED_ONLY_BUYER";
  }

  throw new ScenarioError(
    "ownership verification failure",
    "Non-Buyer release simulation unexpectedly succeeded",
  );
}

async function run() {
  const buyer = loadBuyer();
  const escrowAbi = await loadEscrowAbi();
  const transport = http(avalancheFuji.rpcUrls.default.http[0]);
  const publicClient = createPublicClient({ chain: avalancheFuji, transport });
  const walletClient = createWalletClient({ account: buyer, chain: avalancheFuji, transport });

  let preflight;
  try {
    const [chainId, code, stored, buyerAvax, sellerUsdc, escrowUsdc, buyerUsdc] =
      await Promise.all([
        publicClient.getChainId(),
        publicClient.getCode({ address: ESCROW_ADDRESS }),
        publicClient.readContract({
          address: ESCROW_ADDRESS,
          abi: escrowAbi,
          functionName: "getEscrow",
          args: [PROCUREMENT_ID],
        }),
        publicClient.getBalance({ address: EXPECTED_BUYER }),
        readUsdcBalance(publicClient, EXPECTED_SELLER),
        readUsdcBalance(publicClient, ESCROW_ADDRESS),
        readUsdcBalance(publicClient, EXPECTED_BUYER),
      ]);
    preflight = { chainId, code, stored, buyerAvax, sellerUsdc, escrowUsdc, buyerUsdc };
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
    "Escrow bytecode is absent",
  );
  assertCondition(
    Number(preflight.stored.state) === State.FUNDED,
    "contract/readback failure",
    `Escrow state is ${preflight.stored.state}, not FUNDED; no transaction sent`,
  );
  assertCondition(
    sameHex(preflight.stored.buyer, EXPECTED_BUYER) &&
      sameHex(preflight.stored.seller, EXPECTED_SELLER) &&
      sameHex(preflight.stored.token, USDC_ADDRESS) &&
      preflight.stored.amount === EXPECTED_AMOUNT,
    "contract/readback failure",
    "Stored escrow fields do not match the Slice 2C commitment",
  );
  assertCondition(
    preflight.escrowUsdc === EXPECTED_AMOUNT,
    "USDC balance failure",
    `Escrow USDC balance is ${preflight.escrowUsdc}, not ${EXPECTED_AMOUNT}`,
  );
  assertCondition(
    preflight.buyerAvax > 0n,
    "wallet/gas failure",
    "Buyer has no Fuji AVAX for gas",
  );

  const nonBuyerVerification = await verifyNonBuyerCannotRelease(publicClient, escrowAbi);

  let releaseTxHash;
  let receipt;
  try {
    const simulation = await publicClient.simulateContract({
      account: buyer,
      address: ESCROW_ADDRESS,
      abi: escrowAbi,
      functionName: "release",
      args: [PROCUREMENT_ID],
    });
    releaseTxHash = await walletClient.writeContract(simulation.request);
    receipt = await publicClient.waitForTransactionReceipt({ hash: releaseTxHash });
  } catch (error) {
    const type = shortMessage(error).toLowerCase().includes("insufficient funds")
      ? "wallet/gas failure"
      : "contract/release failure";
    throw new ScenarioError(type, shortMessage(error));
  }
  assertCondition(
    receipt.status === "success",
    "contract/release failure",
    "Release transaction reverted",
  );

  const [storedAfter, sellerAfter, escrowAfter, buyerAfter] = await Promise.all([
    publicClient.readContract({
      address: ESCROW_ADDRESS,
      abi: escrowAbi,
      functionName: "getEscrow",
      args: [PROCUREMENT_ID],
      blockNumber: receipt.blockNumber,
    }),
    readUsdcBalance(publicClient, EXPECTED_SELLER, receipt.blockNumber),
    readUsdcBalance(publicClient, ESCROW_ADDRESS, receipt.blockNumber),
    readUsdcBalance(publicClient, EXPECTED_BUYER, receipt.blockNumber),
  ]);
  const releasedLogs = parseEventLogs({
    abi: escrowAbi,
    eventName: "Released",
    logs: receipt.logs,
    strict: true,
  });
  assertCondition(
    releasedLogs.length === 1,
    "contract/release failure",
    `Expected one Released event, received ${releasedLogs.length}`,
  );
  const released = releasedLogs[0].args;

  assertCondition(
    Number(storedAfter.state) === State.RELEASED,
    "contract/readback failure",
    `Escrow state after release is ${storedAfter.state}, not RELEASED`,
  );
  assertCondition(
    commercialFieldsMatch(preflight.stored, storedAfter),
    "contract/readback failure",
    "Stored commercial fields changed during release",
  );
  assertCondition(
    sellerAfter - preflight.sellerUsdc === EXPECTED_AMOUNT,
    "USDC balance failure",
    "Seller did not receive the exact escrow amount",
  );
  assertCondition(
    preflight.escrowUsdc - escrowAfter === EXPECTED_AMOUNT && escrowAfter === 0n,
    "USDC balance failure",
    "Escrow USDC balance did not decrease to zero by the exact amount",
  );
  assertCondition(
    buyerAfter === preflight.buyerUsdc,
    "USDC balance failure",
    "Buyer received USDC during release",
  );
  assertCondition(
    released.procurementId === PROCUREMENT_ID &&
      sameHex(released.buyer, EXPECTED_BUYER) &&
      sameHex(released.seller, EXPECTED_SELLER) &&
      sameHex(released.token, USDC_ADDRESS) &&
      released.amount === EXPECTED_AMOUNT,
    "contract/release failure",
    "Released event does not match the escrow commitment",
  );

  console.log("[SHADOWBID SLICE 2D LIVE]");
  console.log(`network: ${avalancheFuji.name}`);
  console.log(`chainId: ${preflight.chainId}`);
  console.log(`escrow: ${ESCROW_ADDRESS}`);
  console.log(`escrowBytecode: PRESENT`);
  console.log(`procurementId: ${PROCUREMENT_ID}`);
  console.log(`preflightState: FUNDED (${preflight.stored.state})`);
  console.log(`storedBuyerBefore: ${preflight.stored.buyer}`);
  console.log(`storedSellerBefore: ${preflight.stored.seller}`);
  console.log(`storedTokenBefore: ${preflight.stored.token}`);
  console.log(`storedAmountBefore: ${preflight.stored.amount}`);
  console.log(`storedTermsHashBefore: ${preflight.stored.termsHash}`);
  console.log(`storedDeadlineBefore: ${preflight.stored.deadline}`);
  console.log(`buyerAvaxPreflightWei: ${preflight.buyerAvax}`);
  console.log(`buyerAvaxPreflight: ${formatEther(preflight.buyerAvax)} AVAX`);
  console.log(`sellerUsdcBefore: ${preflight.sellerUsdc}`);
  console.log(`escrowUsdcBefore: ${preflight.escrowUsdc}`);
  console.log(`buyerUsdcBefore: ${preflight.buyerUsdc}`);
  console.log(`nonBuyerReleaseSimulation: ${nonBuyerVerification}`);
  console.log(`releaseTxHash: ${releaseTxHash}`);
  console.log(`receiptStatus: ${receipt.status}`);
  console.log(`releasedEventProcurementId: ${released.procurementId}`);
  console.log(`releasedEventBuyer: ${released.buyer}`);
  console.log(`releasedEventSeller: ${released.seller}`);
  console.log(`releasedEventToken: ${released.token}`);
  console.log(`releasedEventAmount: ${released.amount}`);
  console.log(`stateAfter: RELEASED (${storedAfter.state})`);
  console.log(`storedBuyerAfter: ${storedAfter.buyer}`);
  console.log(`storedSellerAfter: ${storedAfter.seller}`);
  console.log(`storedTokenAfter: ${storedAfter.token}`);
  console.log(`storedAmountAfter: ${storedAfter.amount}`);
  console.log(`storedTermsHashAfter: ${storedAfter.termsHash}`);
  console.log(`storedDeadlineAfter: ${storedAfter.deadline}`);
  console.log(`commercialFieldsUnchanged: PASS`);
  console.log(`sellerUsdcAfter: ${sellerAfter}`);
  console.log(`sellerUsdcDelta: ${sellerAfter - preflight.sellerUsdc}`);
  console.log(`escrowUsdcAfter: ${escrowAfter}`);
  console.log(`escrowUsdcDelta: ${escrowAfter - preflight.escrowUsdc}`);
  console.log(`buyerUsdcAfter: ${buyerAfter}`);
  console.log(`buyerUsdcDelta: ${buyerAfter - preflight.buyerUsdc}`);
  console.log("refundUsed: NO");
  console.log("status: PASS");
}

try {
  await run();
} catch (error) {
  console.error("[SHADOWBID SLICE 2D LIVE]");
  console.error("status: FAIL");
  console.error(`failureType: ${error?.failureType ?? "contract/release failure"}`);
  console.error(`message: ${shortMessage(error)}`);
  process.exitCode = 1;
}
