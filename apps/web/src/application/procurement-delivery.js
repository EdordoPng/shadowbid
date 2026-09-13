import { ExpirationTime } from '@arkiv-network/sdk';
import {
  ENTITY_TYPE,
  assertApplicationId,
  queryDeliveryReceipts,
  readDeliveryReceiptPayload,
} from '@shadowbid/shared/arkiv';
import { assertCanonicalBytes32 } from '@shadowbid/shared/commitment';
import { AVALANCHE_ESCROW_STATE } from '@shadowbid/shared/procurement';
import { uploadDeliverable, retrieveAndVerifyDeliverable } from '../deliverable.js';
import { buildDeliveredContext } from '../delivery.js';
import { releaseAward } from '../release-award.js';
import {
  FUJI_ESCROW_ADDRESS,
  FUJI_USDC_ADDRESS,
  escrowAbi,
  usdcAbi,
} from './avalanche.js';

const DELIVERY_KEY_PREFIX = 'shadowbid:delivery:';
const SWARM_REFERENCE_PATTERN = /^[0-9a-f]{16,128}$/;
const RECEIPT_RETENTION_SECONDS = 30 * 24 * 60 * 60;

function sameAddress(left, right) {
  return left?.toLowerCase() === right?.toLowerCase();
}

function deliveredContext(workspace, uploadedDeliverable, verification) {
  return buildDeliveredContext({
    rfqId: workspace.award.rfqId,
    quoteId: workspace.award.quoteId,
    awardId: workspace.award.awardId,
    buyer: workspace.award.buyer,
    seller: workspace.award.seller,
    specificationRef: workspace.rfq?.specificationRef,
    specificationHash: workspace.rfq?.specificationHash,
    escrowState: workspace.context.escrowState,
    uploadedDeliverable,
    verification,
  });
}

/** Shared reconstruction for a DELIVERED record from metadata alone (no
 * bytes) — used identically whether that metadata came from this browser's
 * own localStorage or from an imported cross-profile handoff link.
 * `retrievedByBuyer` defaults to false (a freshly imported handoff link was
 * never verified by a live retrieval in this browser, so one stays
 * mandatory), but a localStorage reload of a delivery this same browser
 * already retrieved must carry that fact forward — Open/Download and the
 * release gate key off it, and any actual bytes are still always re-fetched
 * from Swarm and re-verified on use, never trusted from this metadata. */
function reconstructDelivery({ awardId, seller, fileName, mediaType, deliverableRef, deliverableHash, workspace, retrievedByBuyer = false }) {
  const uploadedDeliverable = Object.freeze({ deliverableHash, deliverableRef });
  const referenceVerification = Object.freeze({ hashEquality: true });
  const delivered = deliveredContext(workspace, uploadedDeliverable, referenceVerification);
  return Object.freeze({
    awardId,
    seller,
    fileName,
    mediaType,
    uploadedDeliverable,
    referenceVerification,
    retrievedByBuyer,
    context: delivered.context,
    status: delivered.status,
  });
}

function deliveryMetadata(delivery) {
  return Object.freeze({
    deliverableRef: delivery.uploadedDeliverable.deliverableRef,
    deliverableHash: delivery.uploadedDeliverable.deliverableHash,
    fileName: delivery.fileName,
    mediaType: delivery.mediaType,
  });
}

function sameDeliveryMetadata(left, right) {
  return left.deliverableRef === right.deliverableRef &&
    left.deliverableHash === right.deliverableHash &&
    left.fileName === right.fileName &&
    left.mediaType === right.mediaType;
}

function receiptCandidate(entity, workspace) {
  const attributes = entity?.attributes;
  if (!entity?.key || typeof entity.createdAt !== 'bigint' || !attributes) return undefined;
  if (!sameAddress(entity.owner, workspace.award.seller)) return undefined;
  if (!sameAddress(entity.creator, workspace.award.seller)) return undefined;
  if (entity.creationFlags?.readonly !== true || entity.contentType !== 'application/json') return undefined;
  if (attributes.entity_type?.value !== ENTITY_TYPE.DELIVERY_RECEIPT) return undefined;
  if (attributes.award_id?.value !== workspace.award.awardId) return undefined;
  if (!sameAddress(attributes.seller?.value, workspace.award.seller)) return undefined;
  if (typeof attributes.created_at?.value !== 'bigint') return undefined;
  try {
    return Object.freeze({
      entity,
      payload: readDeliveryReceiptPayload(entity),
      createdAt: attributes.created_at.value,
    });
  } catch {
    return undefined;
  }
}

function compareReceiptCandidates(left, right) {
  if (left.entity.createdAt !== right.entity.createdAt) {
    return left.entity.createdAt < right.entity.createdAt ? -1 : 1;
  }
  if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? -1 : 1;
  return left.entity.key.localeCompare(right.entity.key);
}

export async function findCanonicalDeliveryReceipt({ workspace, arkivPublicClient }) {
  const entities = await queryDeliveryReceipts(arkivPublicClient, {
    awardId: workspace.award.awardId,
    seller: workspace.award.seller,
  });
  const candidates = entities
    .map(entity => receiptCandidate(entity, workspace))
    .filter(Boolean)
    .sort(compareReceiptCandidates);
  return candidates[0];
}

export async function discoverDeliveryReceipt({ workspace, arkivPublicClient }) {
  const receipt = await findCanonicalDeliveryReceipt({ workspace, arkivPublicClient });
  if (!receipt) return undefined;
  return Object.freeze({
    ...reconstructDelivery({
      awardId: workspace.award.awardId,
      seller: workspace.award.seller,
      ...receipt.payload,
      workspace,
    }),
    deliveryReceipt: Object.freeze({ entityKey: receipt.entity.key, published: true }),
  });
}

export function canPublishDeliveryReceiptRecovery({ workspace, delivery, seller }) {
  return workspace?.status === 'FUNDED' &&
    sameAddress(seller, workspace.award?.seller) &&
    delivery?.awardId === workspace.award.awardId &&
    sameAddress(delivery.seller, workspace.award.seller) &&
    delivery.referenceVerification?.hashEquality === true &&
    Boolean(delivery.uploadedDeliverable?.deliverableRef) &&
    Boolean(delivery.uploadedDeliverable?.deliverableHash) &&
    delivery.deliveryReceipt?.published !== true;
}

export async function publishDeliveryReceipt({
  workspace,
  delivery,
  arkivPublicClient,
  arkivSellerWriter,
  createdAt = BigInt(Math.floor(Date.now() / 1000)),
}) {
  if (workspace.status !== 'FUNDED') throw new Error('Delivery requires a funded commitment.');
  if (delivery.awardId !== workspace.award.awardId) throw new Error('Delivery does not belong to this Award.');
  if (!sameAddress(delivery.seller, workspace.award.seller) ||
      !sameAddress(arkivSellerWriter?.owner, workspace.award.seller)) {
    throw new Error('Only the Award Seller can publish the delivery receipt.');
  }
  if (delivery.referenceVerification?.hashEquality !== true) {
    throw new Error('Verify the Swarm delivery before publishing its receipt.');
  }

  const metadata = deliveryMetadata(delivery);
  const existing = await findCanonicalDeliveryReceipt({ workspace, arkivPublicClient });
  if (existing) {
    if (!sameDeliveryMetadata(existing.payload, metadata)) {
      throw new Error('Delivery already recorded for this Award.');
    }
    return Object.freeze({
      ...delivery,
      deliveryReceipt: Object.freeze({ entityKey: existing.entity.key, published: true }),
    });
  }

  const deadline = Number(workspace.award.deadline);
  const expires = ExpirationTime.atDate(
    new Date((deadline + RECEIPT_RETENTION_SECONDS) * 1000),
    { atLeast: ExpirationTime.fromDays(30) },
  );
  const result = await arkivSellerWriter.createDeliveryReceipt({
    awardId: workspace.award.awardId,
    createdAt,
    ...metadata,
    expires,
  });
  return Object.freeze({
    ...delivery,
    deliveryReceipt: Object.freeze({ entityKey: result.entityKey, published: true }),
  });
}

export function prepareDelivery({ awardId, seller, fileName, mediaType, bytes }) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
    throw new TypeError('Choose a non-empty deliverable file.');
  }
  if (typeof fileName !== 'string' || fileName.trim().length === 0) {
    throw new TypeError('The deliverable must have a file name.');
  }
  return {
    awardId,
    seller,
    fileName: fileName.trim(),
    mediaType: mediaType || 'application/octet-stream',
    bytes: new Uint8Array(bytes),
    uploaded: undefined,
    result: undefined,
  };
}

export async function submitDeliveryAttempt(attempt, { workspace, swarmClient, onStage = () => {} }) {
  if (workspace.status !== 'FUNDED') throw new Error('Delivery requires a funded commitment.');
  if (attempt.awardId !== workspace.award.awardId) throw new Error('Delivery does not belong to this Award.');
  if (!sameAddress(attempt.seller, workspace.award.seller)) throw new Error('Only the Award Seller can submit delivery.');

  if (!attempt.uploaded) {
    onStage('Storing on Swarm');
    attempt.uploaded = await uploadDeliverable(swarmClient, attempt.bytes);
  }
  onStage('Verifying reference');
  const verification = await retrieveAndVerifyDeliverable(swarmClient, attempt.uploaded);
  const delivered = deliveredContext(workspace, attempt.uploaded, verification);
  attempt.result = Object.freeze({
    awardId: attempt.awardId,
    seller: attempt.seller,
    fileName: attempt.fileName,
    mediaType: attempt.mediaType,
    uploadedDeliverable: attempt.uploaded,
    referenceVerification: verification,
    retrievedByBuyer: false,
    context: delivered.context,
    status: delivered.status,
  });
  onStage('Available');
  return attempt.result;
}

export async function retrieveProcurementDeliverable({ workspace, delivery, swarmClient, buyer, onStage = () => {} }) {
  if (!sameAddress(buyer, workspace.award.buyer)) throw new Error('Only the Award Buyer can retrieve this deliverable.');
  if (delivery.awardId !== workspace.award.awardId) throw new Error('Deliverable does not belong to this Award.');
  onStage('Retrieving from Swarm');
  const verification = await retrieveAndVerifyDeliverable(swarmClient, delivery.uploadedDeliverable);
  onStage('Verifying bytes');
  const delivered = deliveredContext(workspace, delivery.uploadedDeliverable, verification);
  const result = Object.freeze({
    ...delivery,
    buyerVerification: verification,
    retrievedByBuyer: true,
    context: delivered.context,
    status: delivered.status,
  });
  onStage('Deliverable verified');
  return result;
}

/**
 * Fetches the deliverable bytes fresh from Swarm for the Buyer to open or
 * download — never from a cache, since raw bytes are never persisted
 * (localStorage/handoff link only ever carry ref+hash). Re-verifies the
 * hash on every call and refuses to hand back bytes that fail it, so
 * Open/Download can never expose an unverified or tampered file.
 */
export async function fetchDeliverableForDownload({ delivery, swarmClient }) {
  const verification = await retrieveAndVerifyDeliverable(swarmClient, delivery.uploadedDeliverable);
  if (verification.hashEquality !== true) {
    throw new Error('Deliverable failed integrity verification on download; refusing to expose the file.');
  }
  return Object.freeze({
    bytes: verification.retrievedBytes,
    fileName: delivery.fileName || 'deliverable',
    mediaType: delivery.mediaType || 'application/octet-stream',
  });
}

export async function releaseProcurement({ workspace, delivery, fujiPublicClient, fujiWalletClient, onStage = () => {} }) {
  if (!sameAddress(fujiWalletClient.account.address, workspace.award.buyer)) {
    throw new Error('Only the Buyer that owns this Award can release its commitment.');
  }
  if (delivery?.retrievedByBuyer !== true || delivery?.buyerVerification?.hashEquality !== true) {
    throw new Error('Retrieve and verify the deliverable before release.');
  }
  const result = await releaseAward({
    publicClient: fujiPublicClient,
    walletClient: fujiWalletClient,
    escrowAddress: FUJI_ESCROW_ADDRESS,
    escrowAbi,
    usdcAddress: FUJI_USDC_ADDRESS,
    usdcAbi,
    commitment: workspace.commitment,
    context: delivery.context,
    onStage,
  });
  if (!result.resumedAlreadyReleased && result.balanceDelta !== workspace.commitment.amount) {
    throw new Error('Settlement confirmed, but the Seller balance delta does not match the Award amount.');
  }
  return result;
}

/**
 * Device-local cache of delivery metadata only, never deliverable bytes.
 * Cross-profile discovery uses the Seller-owned Arkiv receipt; this cache
 * remains a convenience and preserves real Buyer retrieval state locally.
 * Integrity is never delegated to either metadata source: Buyer retrieval
 * always re-downloads from Swarm and re-verifies the hash.
 */
export function saveDeliverySession(sessionStore, delivery) {
  const payload = {
    awardId: delivery.awardId,
    seller: delivery.seller,
    fileName: delivery.fileName,
    mediaType: delivery.mediaType,
    deliverableRef: delivery.uploadedDeliverable.deliverableRef,
    deliverableHash: delivery.uploadedDeliverable.deliverableHash,
    referenceVerified: delivery.referenceVerification?.hashEquality === true,
    retrievedByBuyer: delivery.retrievedByBuyer === true,
    receiptPublished: delivery.deliveryReceipt?.published === true,
    receiptEntityKey: delivery.deliveryReceipt?.entityKey,
  };
  sessionStore.setItem(`${DELIVERY_KEY_PREFIX}${delivery.awardId}`, JSON.stringify(payload));
}

export function loadDeliverySession(sessionStore, workspace) {
  const serialized = sessionStore.getItem(`${DELIVERY_KEY_PREFIX}${workspace.award.awardId}`);
  if (!serialized) return undefined;
  try {
    const payload = JSON.parse(serialized);
    if (payload.awardId !== workspace.award.awardId || !sameAddress(payload.seller, workspace.award.seller)) return undefined;
    if (payload.referenceVerified !== true) return undefined;
    const delivery = reconstructDelivery({
      awardId: payload.awardId,
      seller: payload.seller,
      fileName: payload.fileName,
      mediaType: payload.mediaType,
      deliverableRef: payload.deliverableRef,
      deliverableHash: payload.deliverableHash,
      retrievedByBuyer: payload.retrievedByBuyer === true,
      workspace,
    });
    return payload.receiptPublished === true
      ? Object.freeze({
          ...delivery,
          deliveryReceipt: Object.freeze({ entityKey: payload.receiptEntityKey, published: true }),
        })
      : delivery;
  } catch {
    return undefined;
  }
}

/**
 * Cross-profile delivery handoff link: the Seller's own browser can build a
 * URL query carrying only non-secret metadata (never raw bytes) that a
 * Buyer in a *different* Chrome profile/machine can open to import the same
 * metadata that would otherwise only reach them via this browser's
 * localStorage. It is purely a transport for the same small identifiers
 * saveDeliverySession already persists — no new protocol state, no Arkiv
 * write, no bytes.
 */
export function buildDeliveryHandoffQuery(delivery) {
  const params = new URLSearchParams({
    awardId: delivery.awardId,
    ref: delivery.uploadedDeliverable.deliverableRef,
    hash: delivery.uploadedDeliverable.deliverableHash,
  });
  if (delivery.fileName) params.set('file', delivery.fileName);
  if (delivery.mediaType) params.set('type', delivery.mediaType);
  return params.toString();
}

/** Validates a handoff query string against the currently opened workspace.
 * Returns undefined (never throws) on anything malformed, mismatched, or
 * absent — an invalid/missing link must never fabricate DELIVERED. */
export function parseDeliveryHandoffQuery(rawQuery, workspace) {
  if (typeof rawQuery !== 'string' || rawQuery.length === 0) return undefined;
  let params;
  try {
    params = new URLSearchParams(rawQuery);
  } catch {
    return undefined;
  }
  const awardId = params.get('awardId');
  const ref = params.get('ref');
  const hash = params.get('hash');
  if (!awardId || !ref || !hash) return undefined;
  try {
    assertApplicationId(awardId, 'awardId');
    assertCanonicalBytes32(hash, 'deliverableHash');
  } catch {
    return undefined;
  }
  if (!SWARM_REFERENCE_PATTERN.test(ref)) return undefined;
  if (awardId.toLowerCase() !== workspace.award.awardId.toLowerCase()) return undefined;
  return Object.freeze({
    deliverableRef: ref,
    deliverableHash: hash,
    fileName: params.get('file') || undefined,
    mediaType: params.get('type') || undefined,
  });
}

/** Reconstructs DELIVERED from validated handoff-link metadata. `metadata`
 * must already be the output of parseDeliveryHandoffQuery — undefined
 * (invalid/absent link) always yields undefined, never a fabricated record. */
export function importDeliveryHandoffLink({ workspace, metadata }) {
  if (!metadata) return undefined;
  return reconstructDelivery({
    awardId: workspace.award.awardId,
    seller: workspace.award.seller,
    fileName: metadata.fileName,
    mediaType: metadata.mediaType,
    deliverableRef: metadata.deliverableRef,
    deliverableHash: metadata.deliverableHash,
    workspace,
  });
}

export function workspaceStatusWithDelivery(workspace, delivery) {
  if (workspace.context.escrowState === AVALANCHE_ESCROW_STATE.RELEASED) return 'SETTLED';
  return delivery ? 'DELIVERED' : workspace.status;
}

/**
 * Economic truth (Fuji RELEASED -> SETTLED) and proof availability (can this
 * browser/session actually show a real specification reference?) are
 * separate concepts. A settled escrow proves economic settlement, not that
 * the ephemeral RFQ's specification is still reconstructable — so a green
 * Verified check must never be shown without a real reference to back it.
 */
export function isSpecificationVerified(workspace) {
  return Boolean(workspace.rfq?.specificationRef);
}

/**
 * The Work Capsule deliverable label must never claim "Retrieved & Accepted"
 * on the strength of Fuji RELEASED alone: that proves economic settlement,
 * not that this specific browser/session holds a real, independently
 * reconstructed delivery record. Only a genuine Buyer retrieval in this
 * session (retrievedByBuyer === true) earns that label.
 */
export function deliverableStateLabel(workspace, delivery) {
  const settled = workspaceStatusWithDelivery(workspace, delivery) === 'SETTLED';
  const retrieved = delivery?.retrievedByBuyer === true;
  if (settled) return retrieved ? 'Retrieved & Accepted' : 'Delivery metadata unavailable';
  if (retrieved) return 'Retrieved from Swarm';
  if (delivery) return 'Available';
  return 'Not submitted';
}
