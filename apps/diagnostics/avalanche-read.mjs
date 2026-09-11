import { createPublicClient, defineChain, formatUnits, http } from "viem";

const EXPECTED_CHAIN_ID = 43113;
const EXPECTED_DECIMALS = 6;
const RPC_URL = "https://api.avax-test.network/ext/bc/C/rpc";
const USDC_ADDRESS = "0x5425890298aed601595a70AB815c96711a31Bc65";

const WALLETS = {
  BUYER: "0x490b01048Af9878434727daF2C3291D2ff8a67B0",
  SELLER_A: "0x4A643d1340F779e5A58a5413eD8908F7e8DC519E",
  SELLER_B: "0xEAAD2aaC9cdFE74F45F95C74E87b981561BcEbaC",
  BACKUP_BUYER: "0x11Bd6A511F13E278009d6985C94905f66De68193",
};

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

const client = createPublicClient({
  chain: avalancheFuji,
  transport: http(RPC_URL),
});

let chainId;
let decimals;
let balances = [];

try {
  chainId = await client.getChainId();
  if (chainId !== EXPECTED_CHAIN_ID) {
    throw new Error(`Unexpected chain ID: ${chainId}`);
  }

  decimals = await client.readContract({
    address: USDC_ADDRESS,
    abi: usdcAbi,
    functionName: "decimals",
  });

  if (decimals !== EXPECTED_DECIMALS) {
    throw new Error(`Unexpected USDC decimals: ${decimals}`);
  }

  balances = await Promise.all(
    Object.entries(WALLETS).map(async ([role, address]) => {
      const raw = await client.readContract({
        address: USDC_ADDRESS,
        abi: usdcAbi,
        functionName: "balanceOf",
        args: [address],
      });

      return { role, raw, formatted: formatUnits(raw, EXPECTED_DECIMALS) };
    }),
  );
} catch {
  balances = [];
}

const passed =
  chainId === EXPECTED_CHAIN_ID &&
  decimals === EXPECTED_DECIMALS &&
  balances.length === Object.keys(WALLETS).length;

console.log("[AVALANCHE READ SMOKE]");
console.log(`network: ${avalancheFuji.name}`);
console.log(`chainId: ${chainId ?? "unavailable"}`);
console.log(`usdc: ${USDC_ADDRESS}`);
console.log(`decimals: ${decimals ?? "unavailable"}`);

for (const role of Object.keys(WALLETS)) {
  const balance = balances.find((entry) => entry.role === role);
  console.log(
    `${role}: raw=${balance?.raw.toString() ?? "unavailable"} formatted=${balance?.formatted ?? "unavailable"}`,
  );
}

console.log(`status: ${passed ? "PASS" : "FAIL"}`);

if (!passed) process.exitCode = 1;
