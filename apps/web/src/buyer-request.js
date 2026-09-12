import { queryRfqById, readRfqPayload } from "@shadowbid/shared/arkiv";
import { createProcurementContext } from "@shadowbid/shared/procurement";

import { uploadSpecification } from "./specification.js";

function toHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Generates one fresh application rfqId. Call once per publish attempt and
 * reuse the same value across retries — never mint a new one on retry. */
export function generateRfqId() {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return `0x${toHex(bytes)}`;
}

/**
 * Thrown when publishBuyerRequest cannot complete. Carries whatever was
 * already produced (rfqId, and specificationRef/specificationHash once the
 * Swarm upload succeeded) so a caller can retry without uploading again.
 */
export class BuyerRequestPublishError extends Error {
  constructor(message, { cause, rfqId, specificationRef, specificationHash }) {
    super(message, { cause });
    this.name = "BuyerRequestPublishError";
    this.rfqId = rfqId;
    this.specificationRef = specificationRef;
    this.specificationHash = specificationHash;
  }
}

/** True if an RFQ with this application rfqId is already on Arkiv. */
async function findExistingRfq(arkivPublicClient, rfqId) {
  const page = await queryRfqById(arkivPublicClient, { rfqId });
  return page.entities[0];
}

/**
 * Independently rereads a published Buyer Request straight from Arkiv —
 * attributes plus the payload's specification linkage — without relying on
 * the in-memory result/context that publishBuyerRequest returned. Returns
 * undefined if no RFQ exists for that rfqId.
 */
export async function readBackBuyerRequest({ arkivPublicClient, rfqId }) {
  const entity = await findExistingRfq(arkivPublicClient, rfqId);
  if (!entity) return undefined;

  const { specificationRef, specificationHash } = readRfqPayload(entity);

  return Object.freeze({
    rfqId: entity.attributes.rfq_id.value,
    rfqEntityKey: entity.key,
    buyer: entity.attributes.buyer.value,
    status: entity.attributes.status.value,
    maxBudget: entity.attributes.max_budget.value,
    maxEtaMinutes: entity.attributes.max_eta_minutes.value,
    specificationRef,
    specificationHash,
  });
}

/**
 * Publishes a real Buyer Request: uploads the exact specification bytes to
 * Swarm, then creates the Buyer-owned RFQ on Arkiv using the existing frozen
 * schema. specificationRef/specificationHash travel only in the RFQ payload
 * (never as query attributes, never the specification bytes themselves), so
 * the linkage survives an independent reread via readBackBuyerRequest and
 * is not dependent on this function's in-memory return value.
 *
 * Retry contract: pass specificationRef + specificationHash back in (instead
 * of specification/swarmClient) to retry the Arkiv write alone without a
 * second Swarm upload. Always pass the same rfqId back in on retry — read it
 * off a thrown BuyerRequestPublishError if the first attempt didn't return.
 * An ambiguous prior Arkiv failure is detected by looking the rfqId up on
 * Arkiv first, so a retry resumes instead of creating a duplicate RFQ.
 */
export async function publishBuyerRequest({
  swarmClient,
  buyerArkivWriter,
  arkivPublicClient,
  rfqId = generateRfqId(),
  specification,
  specificationRef,
  specificationHash,
  title,
  maxBudget,
  maxEtaMinutes,
  createdAt = BigInt(Math.floor(Date.now() / 1_000)),
  expires,
}) {
  let uploaded;
  try {
    uploaded = specificationRef !== undefined && specificationHash !== undefined
      ? { specificationRef, specificationHash }
      : await uploadSpecification(swarmClient, specification);
  } catch (error) {
    throw new BuyerRequestPublishError("Swarm specification upload failed", {
      cause: error,
      rfqId,
    });
  }

  try {
    const existing = await findExistingRfq(arkivPublicClient, rfqId);
    const rfq = existing
      ? { entityKey: existing.key, txHash: undefined, resumedExistingRfq: true }
      : {
          ...(await buyerArkivWriter.createRfq({
            rfqId,
            maxBudget,
            maxEtaMinutes,
            createdAt,
            title,
            expires,
            specificationRef: uploaded.specificationRef,
            specificationHash: uploaded.specificationHash,
          })),
          resumedExistingRfq: false,
        };

    return Object.freeze({
      rfqId,
      buyer: buyerArkivWriter.owner,
      specificationRef: uploaded.specificationRef,
      specificationHash: uploaded.specificationHash,
      rfqEntityKey: rfq.entityKey,
      rfqTxHash: rfq.txHash,
      resumedExistingRfq: rfq.resumedExistingRfq,
      context: createProcurementContext({
        rfqId,
        buyer: buyerArkivWriter.owner,
        specificationRef: uploaded.specificationRef,
        specificationHash: uploaded.specificationHash,
      }),
    });
  } catch (error) {
    throw new BuyerRequestPublishError(
      "Arkiv RFQ creation failed after a successful Swarm upload",
      {
        cause: error,
        rfqId,
        specificationRef: uploaded.specificationRef,
        specificationHash: uploaded.specificationHash,
      },
    );
  }
}
