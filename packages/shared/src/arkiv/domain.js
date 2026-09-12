import { jsonToPayload } from "@arkiv-network/sdk";
import { addr, bytes32, str, u64, u256 } from "@arkiv-network/sdk/attr";

export const ENTITY_TYPE = Object.freeze({
  RFQ: "rfq",
  QUOTE: "quote",
  AWARD: "award",
});

export const SERVICE_TYPE = "security_review";
export const SETTLEMENT_ASSET = "usdc";

export const ENTITY_STATUS = Object.freeze({
  OPEN: "open",
  PENDING_FUNDING: "pending_funding",
});

const EMPTY_CONTENT_TYPE = "application/octet-stream";
const JSON_CONTENT_TYPE = "application/json";
const APPLICATION_ID_PATTERN = /^0x[0-9a-f]{64}$/;

export function assertApplicationId(value, fieldName = "applicationId") {
  if (typeof value !== "string" || !APPLICATION_ID_PATTERN.test(value)) {
    throw new TypeError(
      `${fieldName} must be a canonical 32-byte ID (0x followed by 64 lowercase hex characters)`,
    );
  }

  return value;
}

export function assertMoney(value, fieldName = "amount") {
  if (typeof value !== "bigint" || value < 0n) {
    throw new TypeError(`${fieldName} must be a non-negative bigint in token base units`);
  }

  return value;
}

export function assertDeadline(value, fieldName = "deadline") {
  if (typeof value !== "bigint" || value <= 0n) {
    throw new TypeError(`${fieldName} must be a positive bigint Unix timestamp`);
  }

  u64(value);
  return value;
}

function assertUnsignedInteger(value, fieldName) {
  if (typeof value !== "bigint" || value < 0n) {
    throw new TypeError(`${fieldName} must be a non-negative bigint`);
  }

  return value;
}

function assertTitle(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError("title must be a non-empty string");
  }

  return value;
}

function assertSpecificationRef(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("specificationRef must be a non-empty string");
  }

  return value;
}

function requireExpiry(expires) {
  if (expires === undefined || expires === null) {
    throw new TypeError("expires must be supplied using Arkiv ExpirationTime");
  }

  return expires;
}

export function mapRfqAttributes({
  rfqId,
  buyer,
  maxBudget,
  maxEtaMinutes,
  createdAt,
}) {
  return Object.freeze({
    entity_type: str(ENTITY_TYPE.RFQ),
    rfq_id: bytes32(assertApplicationId(rfqId, "rfqId")),
    buyer: addr(buyer),
    service_type: str(SERVICE_TYPE),
    max_budget: u256(assertMoney(maxBudget, "maxBudget")),
    max_eta_minutes: u64(assertUnsignedInteger(maxEtaMinutes, "maxEtaMinutes")),
    settlement_asset: str(SETTLEMENT_ASSET),
    status: str(ENTITY_STATUS.OPEN),
    created_at: u64(assertUnsignedInteger(createdAt, "createdAt")),
  });
}

export function mapQuoteAttributes({
  quoteId,
  rfqId,
  seller,
  price,
  etaMinutes,
  createdAt,
}) {
  return Object.freeze({
    entity_type: str(ENTITY_TYPE.QUOTE),
    quote_id: bytes32(assertApplicationId(quoteId, "quoteId")),
    rfq_id: bytes32(assertApplicationId(rfqId, "rfqId")),
    seller: addr(seller),
    service_type: str(SERVICE_TYPE),
    price: u256(assertMoney(price, "price")),
    eta_minutes: u64(assertUnsignedInteger(etaMinutes, "etaMinutes")),
    settlement_asset: str(SETTLEMENT_ASSET),
    status: str(ENTITY_STATUS.OPEN),
    created_at: u64(assertUnsignedInteger(createdAt, "createdAt")),
  });
}

export function snapshotSelectedQuote({ quoteId, rfqId, seller, price, settlementAsset }) {
  if (settlementAsset !== SETTLEMENT_ASSET) {
    throw new TypeError(`settlementAsset must be ${SETTLEMENT_ASSET}`);
  }

  return Object.freeze({
    quoteId: assertApplicationId(quoteId, "quoteId"),
    rfqId: assertApplicationId(rfqId, "rfqId"),
    seller: addr(seller).value,
    price: assertMoney(price, "price"),
    settlementAsset,
  });
}

export function snapshotAward({ awardId, buyer, selectedQuote, deadline, ...assertions }) {
  const quote = snapshotSelectedQuote(selectedQuote);
  assertAwardFieldsMatchSelectedQuote(assertions, quote);

  return Object.freeze({
    awardId: assertApplicationId(awardId, "awardId"),
    rfqId: quote.rfqId,
    quoteId: quote.quoteId,
    buyer: addr(buyer).value,
    seller: quote.seller,
    amount: quote.price,
    settlementAsset: quote.settlementAsset,
    deadline: assertDeadline(deadline),
  });
}

function assertAwardFieldsMatchSelectedQuote(input, quote) {
  const comparisons = [
    ["rfqId", quote.rfqId],
    ["quoteId", quote.quoteId],
    ["amount", quote.price],
    ["settlementAsset", quote.settlementAsset],
  ];

  for (const [fieldName, selectedValue] of comparisons) {
    if (input[fieldName] !== undefined && input[fieldName] !== selectedValue) {
      throw new TypeError(`${fieldName} must match the selected Quote`);
    }
  }

  if (
    input.seller !== undefined &&
    addr(input.seller).value.toLowerCase() !== quote.seller.toLowerCase()
  ) {
    throw new TypeError("seller must match the selected Quote");
  }
}

export function mapAwardAttributes(input) {
  const award = snapshotAward(input);

  return Object.freeze({
    entity_type: str(ENTITY_TYPE.AWARD),
    award_id: bytes32(award.awardId),
    rfq_id: bytes32(award.rfqId),
    quote_id: bytes32(award.quoteId),
    buyer: addr(award.buyer),
    seller: addr(award.seller),
    amount: u256(award.amount),
    settlement_asset: str(award.settlementAsset),
    status: str(ENTITY_STATUS.PENDING_FUNDING),
    deadline: u64(award.deadline),
    created_at: u64(assertUnsignedInteger(input.createdAt, "createdAt")),
  });
}

/**
 * The Swarm specification linkage travels in the RFQ payload, never as a
 * query attribute: it is context for reconstructing the request, not a
 * market fact to filter/sort on. Both fields are optional together (an RFQ
 * with no specification yet omits both) but never one without the other.
 */
function buildRfqPayload(input) {
  const payload = { title: assertTitle(input.title) };
  // Optional public presentation fields. Existing RFQ payloads remain unchanged.
  if (input.shortDescription !== undefined) {
    if (typeof input.shortDescription !== "string" || input.shortDescription.length > 1000) {
      throw new TypeError("shortDescription must be a string of at most 1000 characters");
    }
    payload.shortDescription = input.shortDescription;
  }
  if (input.requiredDelivery !== undefined) {
    if (!Array.isArray(input.requiredDelivery) || input.requiredDelivery.length > 20 ||
        input.requiredDelivery.some((item) => typeof item !== "string" || !item.trim() || item.length > 500)) {
      throw new TypeError("requiredDelivery must contain at most 20 non-empty requirements of at most 500 characters");
    }
    payload.requiredDelivery = [...input.requiredDelivery];
  }
  const hasRef = input.specificationRef !== undefined;
  const hasHash = input.specificationHash !== undefined;

  if (hasRef !== hasHash) {
    throw new TypeError("specificationRef and specificationHash must be provided together");
  }
  if (hasRef) {
    payload.specificationRef = assertSpecificationRef(input.specificationRef);
    payload.specificationHash = assertApplicationId(input.specificationHash, "specificationHash");
  }

  return payload;
}

export function buildRfqCreateParameters(input) {
  return Object.freeze({
    attributes: mapRfqAttributes(input),
    payload: jsonToPayload(buildRfqPayload(input)),
    contentType: JSON_CONTENT_TYPE,
    expires: requireExpiry(input.expires),
  });
}

/**
 * Reads an RFQ's public presentation data and specification linkage.
 * Requires the entity to have been fetched with its payload selected.
 */
export function readRfqPayload(entity) {
  const payload = entity.toJson();
  return Object.freeze({
    title: payload.title,
    ...(payload.shortDescription === undefined ? {} : { shortDescription: payload.shortDescription }),
    ...(payload.requiredDelivery === undefined ? {} : { requiredDelivery: payload.requiredDelivery }),
    specificationRef: payload.specificationRef,
    specificationHash: payload.specificationHash,
  });
}

export function buildQuoteCreateParameters(input) {
  return Object.freeze({
    attributes: mapQuoteAttributes(input),
    payload: new Uint8Array(),
    contentType: EMPTY_CONTENT_TYPE,
    expires: requireExpiry(input.expires),
  });
}

export function buildAwardCreateParameters(input) {
  return Object.freeze({
    attributes: mapAwardAttributes(input),
    payload: new Uint8Array(),
    contentType: EMPTY_CONTENT_TYPE,
    expires: requireExpiry(input.expires),
  });
}
