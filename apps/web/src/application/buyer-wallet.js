import { createWalletClient } from '@arkiv-network/sdk';
import { custom, getAddress } from 'viem';
import { createBuyerArkivWriter, createSellerArkivWriter } from '@shadowbid/shared/arkiv';
import { arkivChain } from './market.js';

export async function assertWalletSession(provider, owner) {
  if (!provider?.request) throw new Error('Wallet unavailable. Connect a browser wallet.');
  const [accounts, chain] = await Promise.all([
    provider.request({ method: 'eth_accounts' }), provider.request({ method: 'eth_chainId' }),
  ]);
  if (accounts[0]?.toLowerCase() !== owner.toLowerCase()) throw new Error('Wallet account changed. Reconnect the original account to retry.');
  if (BigInt(chain) !== BigInt(arkivChain.id)) throw new Error('Reconnect your wallet to the request network.');
}
export const assertBuyerSession = assertWalletSession;

export async function connectArkivWallet(provider) {
  if (!provider?.request) throw new Error('Wallet unavailable. Install or open an EVM browser wallet.');
  const accounts = await provider.request({ method: 'eth_requestAccounts' });
  if (!accounts[0]) throw new Error('Wallet unavailable. No account was authorized.');
  const owner = getAddress(accounts[0]);
  const chainId = `0x${arkivChain.id.toString(16)}`;
  if (BigInt(await provider.request({ method: 'eth_chainId' })) !== BigInt(arkivChain.id)) {
    try { await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId }] }); }
    catch (error) {
      if (error.code !== 4902) throw error;
      await provider.request({ method: 'wallet_addEthereumChain', params: [{
        chainId, chainName: arkivChain.name, nativeCurrency: arkivChain.nativeCurrency,
        rpcUrls: arkivChain.rpcUrls.default.http,
      }] });
      await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId }] });
    }
  }
  await assertWalletSession(provider, owner);
  const walletClient = createWalletClient({ account: owner, chain: arkivChain, transport: custom(provider, { retryCount: 0 }) });
  const buyerWriter = createBuyerArkivWriter({ walletClient, buyer: owner });
  const sellerWriter = createSellerArkivWriter({ walletClient, seller: owner });
  return Object.freeze({
    owner,
    async createRfq(input) {
      await assertWalletSession(provider, owner);
      return buyerWriter.createRfq(input);
    },
    async createAward(input) {
      await assertWalletSession(provider, owner);
      return buyerWriter.createAward(input);
    },
    async createQuote(input) {
      await assertWalletSession(provider, owner);
      return sellerWriter.createQuote(input);
    },
    async createDeliveryReceipt(input) {
      await assertWalletSession(provider, owner);
      return sellerWriter.createDeliveryReceipt(input);
    },
  });
}

export const connectBuyerWallet = connectArkivWallet;
