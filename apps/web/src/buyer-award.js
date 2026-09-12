import { queryAwardById, queryOpenQuotes } from "@shadowbid/shared/arkiv";
import {
  assertAwardMatchesQuote,
  assertAwardMatchesRfq,
  createProcurementContext,
} from "@shadowbid/shared/procurement";

import { readBackBuyerRequest } from "./buyer-request.js";

function toHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Generates one fresh application awardId. Call once per award attempt and
 * reuse the same value across retries — never mint a new one on retry. */
export function generateAwardId() {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return `0x${toHex(bytes)}`;
}

/** Thrown when the selected Quote is no longer returned by the canonical
 * eligibility query (expired, or otherwise no longer open) right before
 * Award creation. No Award is ever written when this is thrown. */
export class QuoteNoLongerEligibleError extends Error {
  constructor(quoteId) {
    super(`Quote ${quoteId} is no longer eligible (expired or no longer open)`);
    this.name = "QuoteNoLongerEligibleError";
    this.code = "QUOTE_NO_LONGER_ELIGIBLE";
    this.quoteId = quoteId;
  }
}

/** Thrown when Award creation itself fails after the eligibility revalidation passed. */
export class AwardCreationError extends Error {
  constructor(message, { cause, awardId }) {
    super(message, { cause });
    this.name = "AwardCreationError";
    this.awardId = awardId;
  }
}

/**
 * Runs the canonical Slice 1 compound eligibility query for an RFQ. Reused
 * verbatim: no local re-filtering, no alternate predicate.
 */
export function discoverEligibleQuotes({ arkivPublicClient, rfqId, budget, maxEtaMinutes }) {
  return queryOpenQuotes(arkivPublicClient, { rfqId, budget, maxEtaMinutes });
}

function attributesToSelectedQuote(entity) {
  return Object.freeze({
    quoteId: entity.attributes.quote_id.value,
    rfqId: entity.attributes.rfq_id.value,
    seller: entity.attributes.seller.value,
    price: entity.attributes.price.value,
    settlementAsset: entity.attributes.settlement_asset.value,
  });
}

async function findExistingAward(arkivPublicClient, awardId) {
  const page = await queryAwardById(arkivPublicClient, { awardId });
  return page.entities[0];
}

/**
 * Creates a real Buyer-owned Award from a Quote the Buyer selected earlier.
 * Immediately before writing, reruns the same canonical eligibility query
 * the Buyer used for discovery: if the selected quoteId is no longer
 * returned (expired, or otherwise no longer open), stops with
 * QUOTE_NO_LONGER_ELIGIBLE and never creates an Award. If an Award already
 * exists for this awardId, it must match the intended rfqId/Quote — a
 * mismatch stops as a conflict instead of silently resuming.
 *
 * The returned application context reconstructs specificationRef/
 * specificationHash from a real, independent RFQ readback (never from a
 * hardcoded value), so Slice 4D can carry the linkage forward.
 */
export async function createBuyerAward({
  buyerArkivWriter,
  arkivPublicClient,
  awardId = generateAwardId(),
  rfqId,
  selectedQuoteId,
  deadline,
  createdAt = BigInt(Math.floor(Date.now() / 1_000)),
  expires,
}) {
  const rfq = await readBackBuyerRequest({ arkivPublicClient, rfqId });
  if (!rfq) {
    throw new Error(`RFQ ${rfqId} could not be read back from Arkiv`);
  }

  const page = await discoverEligibleQuotes({
    arkivPublicClient,
    rfqId,
    budget: rfq.maxBudget,
    maxEtaMinutes: rfq.maxEtaMinutes,
  });
  const selectedEntity = page.entities.find(
    (entity) => entity.attributes.quote_id?.value === selectedQuoteId,
  );
  if (!selectedEntity) {
    throw new QuoteNoLongerEligibleError(selectedQuoteId);
  }
  const selectedQuote = attributesToSelectedQuote(selectedEntity);

  // A pre-existing Award for this awardId must match the intended Award
  // exactly — this is a validation concern (ProcurementInvariantViolation
  // from Slice 4A), kept distinct from Arkiv write failures below.
  const existing = await findExistingAward(arkivPublicClient, awardId);
  if (existing) {
    const existingAward = {
      rfqId: existing.attributes.rfq_id.value,
      quoteId: existing.attributes.quote_id.value,
      buyer: existing.attributes.buyer.value,
      seller: existing.attributes.seller.value,
      amount: existing.attributes.amount.value,
    };
    assertAwardMatchesRfq(existingAward, { rfqId, buyer: buyerArkivWriter.owner });
    assertAwardMatchesQuote(existingAward, selectedQuote);
  }

  try {
    const award = existing
      ? { entityKey: existing.key, txHash: undefined, resumedExistingAward: true }
      : {
          ...(await buyerArkivWriter.createAward({
            awardId,
            selectedQuote,
            deadline,
            createdAt,
            expires,
          })),
          resumedExistingAward: false,
        };

    return Object.freeze({
      rfqId,
      quoteId: selectedQuote.quoteId,
      awardId,
      procurementId: awardId,
      buyer: buyerArkivWriter.owner,
      seller: selectedQuote.seller,
      amount: selectedQuote.price,
      settlementAsset: selectedQuote.settlementAsset,
      deadline,
      awardEntityKey: award.entityKey,
      awardTxHash: award.txHash,
      resumedExistingAward: award.resumedExistingAward,
      specificationRef: rfq.specificationRef,
      specificationHash: rfq.specificationHash,
      context: createProcurementContext({
        rfqId,
        quoteId: selectedQuote.quoteId,
        awardId,
        buyer: buyerArkivWriter.owner,
        seller: selectedQuote.seller,
        amount: selectedQuote.price,
        deadline,
        specificationRef: rfq.specificationRef,
        specificationHash: rfq.specificationHash,
      }),
    });
  } catch (error) {
    throw new AwardCreationError("Arkiv Award creation failed", { cause: error, awardId });
  }
}
