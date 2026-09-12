import { ExpirationTime } from '@arkiv-network/sdk';
import { queryAwardById, queryAwardByRfqAndSeller } from '@shadowbid/shared/arkiv';
import { createBuyerAward, discoverEligibleQuotes, generateAwardId } from '../buyer-award.js';
import { generateQuoteId, publishSellerQuote } from '../seller-quote.js';
import { readBackBuyerRequest } from '../buyer-request.js';
import { formatBudget, parseBudget, parseEta, readMarketBlock, service } from './market.js';

const QUOTE_LIFETIMES = new Set([1, 5, 15, 30, 60]);
const AWARD_LIFETIME = ExpirationTime.fromDays(1);
const AWARD_DEADLINE_LEAD_SECONDS = 6n * 60n * 60n;

function quoteFromEntity(entity, snapshotBlock) {
  const attributes = entity.attributes;
  return Object.freeze({
    quoteId: attributes.quote_id.value,
    seller: attributes.seller.value,
    price: attributes.price.value,
    priceLabel: formatBudget(attributes.price.value),
    etaMinutes: attributes.eta_minutes.value,
    settlementAsset: attributes.settlement_asset.value,
    status: attributes.status.value,
    expiresAtBlock: entity.expiresAt,
    snapshotBlock,
  });
}

async function collectEligibleQuotes(arkivPublicClient, rfq) {
  let page = await discoverEligibleQuotes({
    arkivPublicClient,
    rfqId: rfq.rfqId,
    budget: rfq.maxBudget,
    maxEtaMinutes: rfq.maxEtaMinutes,
  });
  const quotes = [];
  let snapshotBlock = page.blockNumber;
  for (;;) {
    snapshotBlock = page.blockNumber;
    quotes.push(...page.entities.map(entity => quoteFromEntity(entity, page.blockNumber)));
    if (!page.hasNextPage()) break;
    page = await page.next();
  }
  return Object.freeze({ quotes: Object.freeze(quotes), snapshotBlock });
}

export async function loadRfqDetail(arkivPublicClient, rfqId) {
  const rfq = await readBackBuyerRequest({ arkivPublicClient, rfqId });
  if (!rfq) return undefined;
  const currentBlock = await readMarketBlock(arkivPublicClient);
  if (rfq.expiresAtBlock !== undefined && rfq.expiresAtBlock <= currentBlock) return undefined;
  const discovery = await collectEligibleQuotes(arkivPublicClient, rfq);
  return Object.freeze({
    ...rfq,
    serviceLabel: rfq.serviceType === service.value ? service.label : rfq.serviceType,
    budgetLabel: formatBudget(rfq.maxBudget),
    requiredDelivery: Array.isArray(rfq.requiredDelivery) ? Object.freeze([...rfq.requiredDelivery]) : Object.freeze([]),
    quotes: discovery.quotes,
    snapshotBlock: discovery.snapshotBlock,
  });
}

export function prepareQuoteAttempt(fields, rfq, seller) {
  const price = parseBudget(fields.price.trim());
  const etaMinutes = parseEta(fields.eta.trim());
  const lifetime = Number(fields.lifetime);
  if (!QUOTE_LIFETIMES.has(lifetime)) throw new TypeError('Select a Quote lifetime.');
  if (price > rfq.maxBudget) throw new TypeError(`Price must be at most ${rfq.budgetLabel} USDC.`);
  if (etaMinutes > rfq.maxEtaMinutes) throw new TypeError(`Delivery ETA must be at most ${rfq.maxEtaMinutes} minutes.`);
  return {
    seller,
    quoteId: generateQuoteId(),
    terms: Object.freeze({
      rfqId: rfq.rfqId,
      price,
      etaMinutes,
      expires: ExpirationTime.fromMinutes(lifetime),
    }),
    result: undefined,
  };
}

export async function submitQuoteAttempt(attempt, { sellerArkivWriter, arkivPublicClient }) {
  if (sellerArkivWriter.owner.toLowerCase() !== attempt.seller.toLowerCase()) {
    throw new Error('Reconnect the original Seller to retry.');
  }
  if (!attempt.result) {
    attempt.result = await publishSellerQuote({
      ...attempt.terms,
      quoteId: attempt.quoteId,
      sellerArkivWriter,
      arkivPublicClient,
    });
  }
  return attempt.result;
}

export function prepareAwardAttempt(rfq, quote) {
  if (!rfq.quotes.some(candidate => candidate.quoteId === quote.quoteId)) {
    throw new Error('Select an active eligible Quote.');
  }
  return {
    buyer: rfq.buyer,
    awardId: generateAwardId(),
    terms: Object.freeze({
      rfqId: rfq.rfqId,
      selectedQuoteId: quote.quoteId,
      deadline: BigInt(Math.floor(Date.now() / 1_000)) + AWARD_DEADLINE_LEAD_SECONDS,
      expires: AWARD_LIFETIME,
    }),
    result: undefined,
  };
}

/**
 * Discovers the real Award (if any) that names `seller` as the winning
 * Seller for `rfqId`, read live from Arkiv — the durable source of truth
 * for award ownership, never inferred from local browser state. Returns
 * the awardId, or undefined if this Seller has not won an Award here.
 */
export async function findAwardedProcurementForSeller({ arkivPublicClient, rfqId, seller }) {
  const page = await queryAwardByRfqAndSeller(arkivPublicClient, { rfqId, seller });
  const entity = page.entities[0];
  return entity ? entity.attributes.award_id.value : undefined;
}

export async function submitAwardAttempt(attempt, { buyerArkivWriter, arkivPublicClient }) {
  if (buyerArkivWriter.owner.toLowerCase() !== attempt.buyer.toLowerCase()) {
    throw new Error('Reconnect the RFQ Buyer to create this Award.');
  }
  if (!attempt.result) {
    attempt.result = await createBuyerAward({
      ...attempt.terms,
      awardId: attempt.awardId,
      buyerArkivWriter,
      arkivPublicClient,
    });
  }
  const page = await queryAwardById(arkivPublicClient, { awardId: attempt.awardId });
  if (!page.entities[0]) throw new Error('Award submitted; it is not readable yet. Retry confirmation.');
  return attempt.result;
}
