import {
  createPublicClient,
  createWalletClient,
  custom,
  defineChain,
  getAddress,
  http,
} from 'viem';

export const FUJI_ESCROW_ADDRESS = getAddress('0xb8d8ba69db07b957c4ce97220bf8b88e558d0738');
export const FUJI_USDC_ADDRESS = getAddress('0x5425890298aed601595a70AB815c96711a31Bc65');
export const FUJI_USDC_DECIMALS = 6;

export const avalancheFuji = defineChain({
  id: 43_113,
  name: 'Avalanche Fuji',
  nativeCurrency: { name: 'Avalanche', symbol: 'AVAX', decimals: 18 },
  rpcUrls: { default: { http: ['https://api.avax-test.network/ext/bc/C/rpc'] } },
  blockExplorers: { default: { name: 'Snowtrace', url: 'https://testnet.snowtrace.io' } },
  testnet: true,
});

export const escrowAbi = Object.freeze([
  {
    type: 'function', name: 'getEscrow', stateMutability: 'view',
    inputs: [{ name: 'procurementId', type: 'bytes32' }],
    outputs: [{ name: '', type: 'tuple', components: [
      { name: 'buyer', type: 'address' }, { name: 'seller', type: 'address' },
      { name: 'token', type: 'address' }, { name: 'amount', type: 'uint256' },
      { name: 'termsHash', type: 'bytes32' }, { name: 'deadline', type: 'uint64' },
      { name: 'state', type: 'uint8' },
    ] }],
  },
  {
    type: 'function', name: 'fund', stateMutability: 'nonpayable', outputs: [],
    inputs: [
      { name: 'procurementId', type: 'bytes32' }, { name: 'seller', type: 'address' },
      { name: 'token', type: 'address' }, { name: 'amount', type: 'uint256' },
      { name: 'termsHash', type: 'bytes32' }, { name: 'deadline', type: 'uint64' },
    ],
  },
  {
    type: 'function', name: 'release', stateMutability: 'nonpayable', outputs: [],
    inputs: [{ name: 'procurementId', type: 'bytes32' }],
  },
  {
    type: 'function', name: 'refundAfterDeadline', stateMutability: 'nonpayable', outputs: [],
    inputs: [{ name: 'procurementId', type: 'bytes32' }],
  },
]);

export const usdcAbi = Object.freeze([
  {
    type: 'function', name: 'allowance', stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function', name: 'approve', stateMutability: 'nonpayable',
    inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function', name: 'balanceOf', stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
]);

export function createFujiPublicClient() {
  return createPublicClient({
    chain: avalancheFuji,
    transport: http(undefined, { timeout: 15_000, retryCount: 1 }),
  });
}

async function switchToFuji(provider) {
  const chainId = `0x${avalancheFuji.id.toString(16)}`;
  if (BigInt(await provider.request({ method: 'eth_chainId' })) === BigInt(avalancheFuji.id)) return;
  try {
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId }] });
  } catch (error) {
    if (error.code !== 4902) throw error;
    await provider.request({ method: 'wallet_addEthereumChain', params: [{
      chainId,
      chainName: avalancheFuji.name,
      nativeCurrency: avalancheFuji.nativeCurrency,
      rpcUrls: avalancheFuji.rpcUrls.default.http,
      blockExplorerUrls: [avalancheFuji.blockExplorers.default.url],
    }] });
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId }] });
  }
}

export async function connectFujiBuyerWallet(provider, expectedBuyer) {
  if (!provider?.request) throw new Error('Wallet unavailable. Install or open an EVM browser wallet.');
  const accounts = await provider.request({ method: 'eth_requestAccounts' });
  if (!accounts[0]) throw new Error('Wallet unavailable. No account was authorized.');
  const buyer = getAddress(accounts[0]);
  if (buyer.toLowerCase() !== expectedBuyer.toLowerCase()) throw new Error('Connect the Buyer that owns this Award.');
  await switchToFuji(provider);
  const [activeAccounts, activeChain] = await Promise.all([
    provider.request({ method: 'eth_accounts' }),
    provider.request({ method: 'eth_chainId' }),
  ]);
  if (activeAccounts[0]?.toLowerCase() !== buyer.toLowerCase()) throw new Error('Wallet account changed. Reconnect the Award Buyer.');
  if (BigInt(activeChain) !== BigInt(avalancheFuji.id)) throw new Error('Reconnect your wallet to Avalanche Fuji.');
  return Object.freeze({
    owner: buyer,
    walletClient: createWalletClient({
      account: buyer,
      chain: avalancheFuji,
      transport: custom(provider, { retryCount: 0 }),
    }),
  });
}

export function fujiTransactionUrl(txHash) {
  return `${avalancheFuji.blockExplorers.default.url}/tx/${txHash}`;
}
