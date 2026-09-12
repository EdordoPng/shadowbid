import { bytes32, str, u64, u256 } from "@arkiv-network/sdk/attr";
import { and, eq, lte } from "@arkiv-network/sdk/query";

import {
  assertApplicationId,
  assertMoney,
  ENTITY_STATUS,
  ENTITY_TYPE,
  SERVICE_TYPE,
  SETTLEMENT_ASSET,
} from "./domain.js";

function assertMaxEtaMinutes(value) {
  if (typeof value !== "bigint" || value < 0n) {
    throw new TypeError("maxEtaMinutes must be a non-negative bigint");
  }

  return value;
}

export function buildOpenQuotePredicate({ rfqId, budget, maxEtaMinutes }) {
  return and(
    eq("entity_type", str(ENTITY_TYPE.QUOTE)),
    eq("rfq_id", bytes32(assertApplicationId(rfqId, "rfqId"))),
    eq("service_type", str(SERVICE_TYPE)),
    lte("price", u256(assertMoney(budget, "budget"))),
    lte("eta_minutes", u64(assertMaxEtaMinutes(maxEtaMinutes))),
    eq("settlement_asset", str(SETTLEMENT_ASSET)),
    eq("status", str(ENTITY_STATUS.OPEN)),
  );
}

export function createOpenQuoteQuery(publicClient, criteria, { limit = 100 } = {}) {
  return publicClient
    .select({ key: true, expiresAt: true, attributes: true })
    .where(buildOpenQuotePredicate(criteria))
    .limit(limit);
}

export function queryOpenQuotes(publicClient, criteria, options) {
  return createOpenQuoteQuery(publicClient, criteria, options).fetch();
}

/** Active Quote membership for Market counts. Native Arkiv expiry remains
 * authoritative: expired entities are absent from this query result. */
export function buildActiveQuotesByRfqPredicate({ rfqId }) {
  return and(
    eq("entity_type", str(ENTITY_TYPE.QUOTE)),
    eq("rfq_id", bytes32(assertApplicationId(rfqId, "rfqId"))),
    eq("status", str(ENTITY_STATUS.OPEN)),
  );
}

export function createActiveQuotesByRfqQuery(
  publicClient,
  criteria,
  { limit = 200, atBlock } = {},
) {
  const query = publicClient
    .select({ key: true })
    .where(buildActiveQuotesByRfqPredicate(criteria))
    .limit(limit);
  return atBlock === undefined ? query : query.atBlock(atBlock);
}

export function queryActiveQuotesByRfq(publicClient, criteria, options) {
  return createActiveQuotesByRfqQuery(publicClient, criteria, options).fetch();
}

export function buildRfqByIdPredicate({ rfqId }) {
  return and(
    eq("entity_type", str(ENTITY_TYPE.RFQ)),
    eq("rfq_id", bytes32(assertApplicationId(rfqId, "rfqId"))),
  );
}

export function createRfqByIdQuery(publicClient, criteria, { limit = 1 } = {}) {
  return publicClient
    .select({ key: true, expiresAt: true, attributes: true, payload: true })
    .where(buildRfqByIdPredicate(criteria))
    .limit(limit);
}

export function queryRfqById(publicClient, criteria, options) {
  return createRfqByIdQuery(publicClient, criteria, options).fetch();
}

export function buildQuoteByIdPredicate({ quoteId }) {
  return and(
    eq("entity_type", str(ENTITY_TYPE.QUOTE)),
    eq("quote_id", bytes32(assertApplicationId(quoteId, "quoteId"))),
  );
}

export function createQuoteByIdQuery(publicClient, criteria, { limit = 1 } = {}) {
  return publicClient
    .select({ key: true, attributes: true })
    .where(buildQuoteByIdPredicate(criteria))
    .limit(limit);
}

export function queryQuoteById(publicClient, criteria, options) {
  return createQuoteByIdQuery(publicClient, criteria, options).fetch();
}

export function buildAwardByIdPredicate({ awardId }) {
  return and(
    eq("entity_type", str(ENTITY_TYPE.AWARD)),
    eq("award_id", bytes32(assertApplicationId(awardId, "awardId"))),
  );
}

export function createAwardByIdQuery(publicClient, criteria, { limit = 1 } = {}) {
  return publicClient
    .select({ key: true, attributes: true })
    .where(buildAwardByIdPredicate(criteria))
    .limit(limit);
}

export function queryAwardById(publicClient, criteria, options) {
  return createAwardByIdQuery(publicClient, criteria, options).fetch();
}
