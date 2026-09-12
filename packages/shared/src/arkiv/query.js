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
    .select({ key: true, attributes: true })
    .where(buildOpenQuotePredicate(criteria))
    .limit(limit);
}

export function queryOpenQuotes(publicClient, criteria, options) {
  return createOpenQuoteQuery(publicClient, criteria, options).fetch();
}
