import { addr } from "@arkiv-network/sdk/attr";

import {
  buildAwardCreateParameters,
  buildQuoteCreateParameters,
  buildRfqCreateParameters,
  buildDeliveryReceiptCreateParameters,
} from "./domain.js";

function requireOwnedWallet(walletClient, owner, role) {
  if (typeof walletClient?.createEntity !== "function") {
    throw new TypeError(`${role} walletClient must expose createEntity`);
  }

  const canonicalOwner = addr(owner).value;
  const signerAddress = walletClient.account?.address;

  if (typeof signerAddress !== "string") {
    throw new TypeError(`${role} walletClient must expose its signer account address`);
  }

  if (signerAddress.toLowerCase() !== canonicalOwner.toLowerCase()) {
    throw new Error(`${role} wallet signer does not match the declared owner`);
  }

  return canonicalOwner;
}

export function createBuyerArkivWriter({ walletClient, buyer }) {
  const owner = requireOwnedWallet(walletClient, buyer, "buyer");

  return Object.freeze({
    role: "buyer",
    owner,
    createRfq: (input) =>
      walletClient.createEntity(buildRfqCreateParameters({ ...input, buyer: owner })),
    createAward: (input) =>
      walletClient.createEntity(buildAwardCreateParameters({ ...input, buyer: owner })),
  });
}

export function createSellerArkivWriter({ walletClient, seller }) {
  const owner = requireOwnedWallet(walletClient, seller, "seller");

  return Object.freeze({
    role: "seller",
    owner,
    createQuote: (input) =>
      walletClient.createEntity(buildQuoteCreateParameters({ ...input, seller: owner })),
    createDeliveryReceipt: (input) =>
      walletClient.createEntity(buildDeliveryReceiptCreateParameters({ ...input, seller: owner })),
  });
}
