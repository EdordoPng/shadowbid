import {
  encodeAbiParameters,
  getAddress,
  keccak256,
  stringToBytes,
} from "viem";

import {
  SETTLEMENT_ASSET,
  assertApplicationId,
  assertDeadline,
  assertMoney,
} from "./arkiv/domain.js";

export const TERMS_HASH_VERSION = 1n;

export const TERMS_HASH_FIELDS = Object.freeze([
  Object.freeze({ name: "version", type: "uint256" }),
  Object.freeze({ name: "rfqId", type: "bytes32" }),
  Object.freeze({ name: "quoteId", type: "bytes32" }),
  Object.freeze({ name: "awardId", type: "bytes32" }),
  Object.freeze({ name: "buyer", type: "address" }),
  Object.freeze({ name: "seller", type: "address" }),
  Object.freeze({ name: "token", type: "address" }),
  Object.freeze({ name: "amount", type: "uint256" }),
  Object.freeze({ name: "deadline", type: "uint64" }),
  Object.freeze({ name: "specificationHash", type: "bytes32" }),
]);

const CANONICAL_BYTES32_PATTERN = /^0x[0-9a-f]{64}$/;

export function assertCanonicalBytes32(value, fieldName = "hash") {
  if (typeof value !== "string" || !CANONICAL_BYTES32_PATTERN.test(value)) {
    throw new TypeError(
      `${fieldName} must be canonical bytes32 (0x followed by 64 lowercase hex characters)`,
    );
  }

  return value;
}

export function procurementIdFromAwardId(awardId) {
  return assertApplicationId(awardId, "awardId");
}

export function hashSpecification(specification) {
  if (typeof specification === "string") {
    return keccak256(stringToBytes(specification));
  }

  if (specification instanceof Uint8Array) {
    return keccak256(specification);
  }

  throw new TypeError("specification must be a string or Uint8Array");
}

function normalizeTermsInput(input) {
  return Object.freeze({
    rfqId: assertApplicationId(input.rfqId, "rfqId"),
    quoteId: assertApplicationId(input.quoteId, "quoteId"),
    awardId: assertApplicationId(input.awardId, "awardId"),
    buyer: getAddress(input.buyer),
    seller: getAddress(input.seller),
    token: getAddress(input.token),
    amount: assertMoney(input.amount),
    deadline: assertDeadline(input.deadline),
    specificationHash: assertCanonicalBytes32(
      input.specificationHash,
      "specificationHash",
    ),
  });
}

export function deriveTermsHash(input) {
  const terms = normalizeTermsInput(input);
  const encoded = encodeAbiParameters(TERMS_HASH_FIELDS, [
    TERMS_HASH_VERSION,
    terms.rfqId,
    terms.quoteId,
    terms.awardId,
    terms.buyer,
    terms.seller,
    terms.token,
    terms.amount,
    terms.deadline,
    terms.specificationHash,
  ]);

  return keccak256(encoded);
}

export function buildEscrowCommitmentInput({ award, token, specificationHash }) {
  if (award.settlementAsset !== SETTLEMENT_ASSET) {
    throw new TypeError(`Award settlementAsset must be ${SETTLEMENT_ASSET}`);
  }

  const terms = normalizeTermsInput({ ...award, token, specificationHash });
  if (terms.amount === 0n) {
    throw new TypeError("Award amount must be greater than zero for escrow funding");
  }

  return Object.freeze({
    procurementId: procurementIdFromAwardId(terms.awardId),
    seller: terms.seller,
    token: terms.token,
    amount: terms.amount,
    termsHash: deriveTermsHash(terms),
    deadline: terms.deadline,
  });
}
