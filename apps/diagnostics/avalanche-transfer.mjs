import {
  createPublicClient,
  createWalletClient,
  defineChain,
  formatUnits,
  http,
  parseUnits,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const EXPECTED_CHAIN_ID = 43113;
const EXPECTED_DECIMALS = 6;
const RPC_URL = "https://api.avax-test.network/ext/bc/C/rpc";
const USDC_ADDRESS = "0x5425890298aed601595a70AB815c96711a31Bc65";
const BUYER_ADDRESS = "0x490b01048Af9878434727daF2C3291D2ff8a67B0";
const SELLER_A_ADDRESS = "0x4A643d1340F779e5A58a5413eD8908F7e8DC519E";
const TRANSFER_AMOUNT = parseUnits("0.01", EXPECTED_DECIMALS);
const privateKey = process.env.SHADOWBID_BUYER_PRIVATE_KEY;

if (!privateKey) {
  console.error("SHADOWBID_BUYER_PRIVATE_KEY is missing");
  process.exit(1);
}

const account = privateKeyToAccount(privateKey);

if (account.address.toLowerCase() !== BUYER_ADDRESS.toLowerCase()) {
  console.error("SHADOWBID_BUYER_PRIVATE_KEY address mismatch");
  process.exit(1);
}

const avalancheFuji = defineChain({
  id: EXPECTED_CHAIN_ID,
  name: "Avalanche Fuji",
  nativeCurrency: {
    name: "Avalanche",
    symbol: "AVAX",
    decimals: 18,
  },
  rpcUrls: {
    default: { http: [RPC_URL] },
  },
  testnet: true,
});

const usdcAbi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint8" }],
  },
];

const transport = http(RPC_URL);
const publicClient = createPublicClient({ chain: avalancheFuji, transport });
const walletClient = createWalletClient({ account, chain: avalancheFuji, transport });

const readBalance = (address, blockNumber) =>
  publicClient.readContract({
    address: USDC_ADDRESS,
    abi: usdcAbi,
    functionName: "balanceOf",
    args: [address],
    ...(blockNumber === undefined ? {} : { blockNumber }),
  });

let chainId;
let buyerBefore;
let sellerBefore;
let txHash;
let receiptPassed = false;
let buyerAfter;
let sellerAfter;
let balanceDeltaCheck = false;

try {
  chainId = await publicClient.getChainId();
  if (chainId !== EXPECTED_CHAIN_ID) {
    throw new Error(`Unexpected chain ID: ${chainId}`);
  }

  const decimals = await publicClient.readContract({
    address: USDC_ADDRESS,
    abi: usdcAbi,
    functionName: "decimals",
  });
  if (decimals !== EXPECTED_DECIMALS) {
    throw new Error(`Unexpected USDC decimals: ${decimals}`);
  }

  [buyerBefore, sellerBefore] = await Promise.all([
    readBalance(BUYER_ADDRESS),
    readBalance(SELLER_A_ADDRESS),
  ]);
  if (buyerBefore < TRANSFER_AMOUNT) {
    throw new Error("Insufficient Buyer USDC balance");
  }

  const simulation = await publicClient.simulateContract({
    account,
    address: USDC_ADDRESS,
    abi: usdcAbi,
    functionName: "transfer",
    args: [SELLER_A_ADDRESS, TRANSFER_AMOUNT],
  });
  if (simulation.result !== true) {
    throw new Error("USDC transfer simulation returned false");
  }

  txHash = await walletClient.writeContract(simulation.request);
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  receiptPassed = receipt.status === "success";
  if (!receiptPassed) throw new Error("USDC transfer transaction reverted");

  [buyerAfter, sellerAfter] = await Promise.all([
    readBalance(BUYER_ADDRESS, receipt.blockNumber),
    readBalance(SELLER_A_ADDRESS, receipt.blockNumber),
  ]);

  balanceDeltaCheck =
    buyerBefore - buyerAfter === TRANSFER_AMOUNT &&
    sellerAfter - sellerBefore === TRANSFER_AMOUNT;
} catch {
  balanceDeltaCheck = false;
}

const formatBalance = (balance) =>
  balance === undefined
    ? "unavailable"
    : `${formatUnits(balance, EXPECTED_DECIMALS)} USDC (raw: ${balance.toString()})`;
const passed = receiptPassed && balanceDeltaCheck;

console.log("[AVALANCHE USDC TRANSFER SMOKE]");
console.log(`network: ${avalancheFuji.name}`);
console.log(`chainId: ${chainId ?? "unavailable"}`);
console.log(`token: ${USDC_ADDRESS}`);
console.log(`from: ${account.address}`);
console.log(`to: ${SELLER_A_ADDRESS}`);
console.log("amount: 0.01 USDC");
console.log(`buyerBefore: ${formatBalance(buyerBefore)}`);
console.log(`sellerBefore: ${formatBalance(sellerBefore)}`);
console.log(`txHash: ${txHash ?? "unavailable"}`);
console.log(`receipt: ${receiptPassed ? "PASS" : "FAIL"}`);
console.log(`buyerAfter: ${formatBalance(buyerAfter)}`);
console.log(`sellerAfter: ${formatBalance(sellerAfter)}`);
console.log(`balanceDeltaCheck: ${balanceDeltaCheck ? "PASS" : "FAIL"}`);
console.log(`status: ${passed ? "PASS" : "FAIL"}`);

if (!passed) process.exitCode = 1;
