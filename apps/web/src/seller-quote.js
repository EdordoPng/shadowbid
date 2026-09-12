import { queryQuoteById } from "@shadowbid/shared/arkiv";

function toHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Generates one fresh application quoteId. Call once per publish attempt
 * and reuse the same value across retries — never mint a new one on retry. */
export function generateQuoteId() {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return `0x${toHex(bytes)}`;
}

/** Thrown when publishSellerQuote cannot complete. Carries the quoteId that
 * was attempted so a caller can retry with the same id. */
export class SellerQuotePublishError extends Error {
  constructor(message, { cause, quoteId }) {
    super(message, { cause });
    this.name = "SellerQuotePublishError";
    this.quoteId = quoteId;
  }
}

async function findExistingQuote(arkivPublicClient, quoteId) {
  const page = await queryQuoteById(arkivPublicClient, { quoteId });
  return page.entities[0];
}

/**
 * Publishes a real Seller-owned Quote against an existing RFQ, using the
 * existing frozen Quote schema/writer unchanged. Checks whether a Quote with
 * this quoteId already exists before writing, so a retry after an ambiguous
 * failure resumes instead of creating a duplicate Quote.
 */
export async function publishSellerQuote({
  sellerArkivWriter,
  arkivPublicClient,
  quoteId = generateQuoteId(),
  rfqId,
  price,
  etaMinutes,
  createdAt = BigInt(Math.floor(Date.now() / 1_000)),
  expires,
}) {
  try {
    const existing = await findExistingQuote(arkivPublicClient, quoteId);
    const quote = existing
      ? { entityKey: existing.key, txHash: undefined, resumedExistingQuote: true }
      : {
          ...(await sellerArkivWriter.createQuote({
            quoteId,
            rfqId,
            price,
            etaMinutes,
            createdAt,
            expires,
          })),
          resumedExistingQuote: false,
        };

    return Object.freeze({
      quoteId,
      rfqId,
      seller: sellerArkivWriter.owner,
      price,
      etaMinutes,
      quoteEntityKey: quote.entityKey,
      quoteTxHash: quote.txHash,
      quoteExpiresAt: quote.expiresAt,
      resumedExistingQuote: quote.resumedExistingQuote,
    });
  } catch (error) {
    throw new SellerQuotePublishError("Arkiv Quote creation failed", { cause: error, quoteId });
  }
}
