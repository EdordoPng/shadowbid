import assert from 'node:assert/strict';
import test from 'node:test';
import { createProcurementContext, AVALANCHE_ESCROW_STATE } from '@shadowbid/shared/procurement';
import { deriveTermsHash } from '@shadowbid/shared/commitment';
import {
  buildDeliveryHandoffQuery,
  fetchDeliverableForDownload,
  importDeliveryHandoffLink,
  loadDeliverySession,
  parseDeliveryHandoffQuery,
  prepareDelivery,
  releaseProcurement,
  retrieveProcurementDeliverable,
  saveDeliverySession,
  submitDeliveryAttempt,
  workspaceStatusWithDelivery,
} from '../src/application/procurement-delivery.js';
import { createPublicWorkReader, SWARM_GATEWAY } from '../src/application/swarm-reader.js';

const RFQ_ID = `0x${'11'.repeat(32)}`;
const QUOTE_ID = `0x${'22'.repeat(32)}`;
const AWARD_ID = `0x${'33'.repeat(32)}`;
const BUYER = '0x490b01048Af9878434727daF2C3291D2ff8a67B0';
const SELLER = '0x4A643d1340F779e5A58a5413eD8908F7e8DC519E';
const TOKEN = '0x5425890298aed601595a70AB815c96711a31Bc65';
const SPECIFICATION_HASH = `0x${'44'.repeat(32)}`;
const TERMS_HASH = deriveTermsHash({
  rfqId: RFQ_ID, quoteId: QUOTE_ID, awardId: AWARD_ID, buyer: BUYER,
  seller: SELLER, token: TOKEN, amount: 5n, deadline: 1_900_000_000n,
  specificationHash: SPECIFICATION_HASH,
});

function workspace(escrowState = AVALANCHE_ESCROW_STATE.FUNDED) {
  return {
    status: escrowState === AVALANCHE_ESCROW_STATE.RELEASED ? 'SETTLED' : 'FUNDED',
    award: { awardId: AWARD_ID, rfqId: RFQ_ID, quoteId: QUOTE_ID, buyer: BUYER, seller: SELLER },
    rfq: { specificationRef: 'a'.repeat(64), specificationHash: SPECIFICATION_HASH },
    commitment: { procurementId: AWARD_ID, seller: SELLER, token: TOKEN, amount: 5n, deadline: 1_900_000_000n, termsHash: TERMS_HASH },
    context: createProcurementContext({
      rfqId: RFQ_ID, quoteId: QUOTE_ID, awardId: AWARD_ID, buyer: BUYER, seller: SELLER,
      specificationRef: 'a'.repeat(64), specificationHash: SPECIFICATION_HASH, escrowState,
    }),
  };
}

function swarm({ corrupt = false } = {}) {
  const stored = new Map();
  return {
    uploadCount: 0,
    async uploadData(bytes) { this.uploadCount += 1; stored.set('b'.repeat(64), new Uint8Array(bytes)); return { reference: 'b'.repeat(64) }; },
    async downloadData(ref) { const bytes = stored.get(ref); return corrupt ? Uint8Array.of(0xff) : new Uint8Array(bytes); },
  };
}

async function delivered() {
  const client = swarm();
  const attempt = prepareDelivery({ awardId: AWARD_ID, seller: SELLER, fileName: 'report.md', mediaType: 'text/markdown', bytes: Uint8Array.of(1, 2, 3) });
  return submitDeliveryAttempt(attempt, { workspace: workspace(), swarmClient: client });
}

test('Seller delivery uses the existing exact-byte Swarm path and derives DELIVERED', async () => {
  const client = swarm();
  const stages = [];
  const attempt = prepareDelivery({ awardId: AWARD_ID, seller: SELLER, fileName: 'report.md', mediaType: 'text/markdown', bytes: Uint8Array.of(0, 1, 2, 255) });
  const result = await submitDeliveryAttempt(attempt, { workspace: workspace(), swarmClient: client, onStage: stage => stages.push(stage) });
  assert.equal(client.uploadCount, 1);
  assert.equal(result.status, 'DELIVERED');
  assert.equal(result.referenceVerification.byteEquality, true);
  assert.equal(result.referenceVerification.hashEquality, true);
  assert.deepEqual(stages, ['Storing on Swarm', 'Verifying reference', 'Available']);
});

test('Buyer retrieval repeats real byte/hash verification and rejects corrupted bytes', async () => {
  const delivery = await delivered();
  await assert.rejects(retrieveProcurementDeliverable({
    workspace: workspace(), delivery, buyer: BUYER,
    swarmClient: { async downloadData() { return Uint8Array.of(9, 9, 9); } },
  }), /integrity verification/);
  assert.equal(delivery.retrievedByBuyer, false);
});

test('delivery metadata (never raw bytes) survives account switching but requires a fresh Buyer retrieval after reload', async () => {
  const delivery = await delivered();
  const map = new Map();
  const store = { setItem: (key, value) => map.set(key, value), getItem: key => map.get(key) };
  saveDeliverySession(store, delivery);
  assert.equal(JSON.parse(map.values().next().value).deliverableBytes, undefined);
  const restored = loadDeliverySession(store, workspace());
  assert.equal(restored.uploadedDeliverable.deliverableRef, delivery.uploadedDeliverable.deliverableRef);
  assert.equal(restored.uploadedDeliverable.deliverableHash, delivery.uploadedDeliverable.deliverableHash);
  assert.equal(restored.uploadedDeliverable.deliverableBytes, undefined);
  assert.equal(restored.retrievedByBuyer, false);
  assert.equal(workspaceStatusWithDelivery(workspace(), restored), 'DELIVERED');
});

test('a reload after real Buyer retrieval (including post-SETTLED) restores retrievedByBuyer, not just DELIVERED', async () => {
  const delivery = await delivered();
  const map = new Map();
  const store = { setItem: (key, value) => map.set(key, value), getItem: key => map.get(key) };
  const retrieved = await retrieveProcurementDeliverable({
    workspace: workspace(), delivery, buyer: BUYER,
    swarmClient: { async downloadData() { return new Uint8Array(delivery.uploadedDeliverable.deliverableBytes); } },
  });
  saveDeliverySession(store, retrieved);
  assert.equal(JSON.parse(map.values().next().value).retrievedByBuyer, true);

  // Reload against a SETTLED workspace (escrow already RELEASED), mirroring
  // opening the workspace again after a real release.
  const settledWorkspace = workspace(AVALANCHE_ESCROW_STATE.RELEASED);
  const restored = loadDeliverySession(store, settledWorkspace);
  assert.equal(restored.retrievedByBuyer, true);
  assert.equal(workspaceStatusWithDelivery(settledWorkspace, restored), 'SETTLED');
});

test('public Work Capsule reader retrieves the exact Swarm bytes endpoint', async () => {
  const bytes = Uint8Array.of(3, 2, 1);
  let requested;
  const reader = createPublicWorkReader(async url => {
    requested = url;
    return { ok: true, async arrayBuffer() { return bytes.buffer; } };
  });
  assert.deepEqual(await reader.downloadData('ref'), bytes);
  assert.equal(requested, `${SWARM_GATEWAY}bytes/ref`);
});

test('release remains blocked until Buyer retrieval and then verifies exact Seller balance delta', async () => {
  const base = workspace();
  const delivery = await delivered();
  const calls = [];
  const publicClient = {
    released: false,
    balance: 10n,
    async readContract({ functionName }) {
      if (functionName === 'getEscrow') return { state: this.released ? 2 : 1, termsHash: TERMS_HASH };
      if (functionName === 'balanceOf') return this.balance;
      throw new Error('unexpected read');
    },
    async simulateContract() { return { request: { functionName: 'release' } }; },
    async waitForTransactionReceipt() { this.released = true; this.balance += 5n; return { status: 'success', blockNumber: 1n }; },
  };
  const walletClient = { account: { address: BUYER }, async writeContract() { calls.push('release'); return `0x${'55'.repeat(32)}`; } };
  await assert.rejects(releaseProcurement({ workspace: base, delivery, fujiPublicClient: publicClient, fujiWalletClient: walletClient }), /Retrieve and verify/);
  assert.equal(calls.length, 0);
  const retrieved = await retrieveProcurementDeliverable({ workspace: base, delivery, buyer: BUYER, swarmClient: { async downloadData() { return new Uint8Array(delivery.uploadedDeliverable.deliverableBytes); } } });
  const result = await releaseProcurement({ workspace: base, delivery: retrieved, fujiPublicClient: publicClient, fujiWalletClient: walletClient });
  assert.equal(result.status, 'SETTLED');
  assert.equal(result.balanceDelta, 5n);
  assert.deepEqual(calls, ['release']);
});

test('release proceeds even after the RFQ has expired, once the escrow was already FUNDED (commitment sourced from chain, not re-derived from the RFQ)', async () => {
  const base = workspace();
  const expiredRfqWorkspace = { ...base, rfq: undefined };
  const delivery = await delivered();
  const calls = [];
  const publicClient = {
    released: false,
    balance: 10n,
    async readContract({ functionName }) {
      if (functionName === 'getEscrow') return { state: this.released ? 2 : 1, termsHash: TERMS_HASH };
      if (functionName === 'balanceOf') return this.balance;
      throw new Error('unexpected read');
    },
    async simulateContract() { return { request: { functionName: 'release' } }; },
    async waitForTransactionReceipt() { this.released = true; this.balance += 5n; return { status: 'success', blockNumber: 1n }; },
  };
  const walletClient = { account: { address: BUYER }, async writeContract() { calls.push('release'); return `0x${'55'.repeat(32)}`; } };
  const retrieved = await retrieveProcurementDeliverable({
    workspace: expiredRfqWorkspace, delivery, buyer: BUYER,
    swarmClient: { async downloadData() { return new Uint8Array(delivery.uploadedDeliverable.deliverableBytes); } },
  });
  assert.equal(retrieved.retrievedByBuyer, true);
  const result = await releaseProcurement({ workspace: expiredRfqWorkspace, delivery: retrieved, fujiPublicClient: publicClient, fujiWalletClient: walletClient });
  assert.equal(result.status, 'SETTLED');
  assert.deepEqual(calls, ['release']);
});

test('cross-profile handoff link carries only metadata and lets a different profile reconstruct DELIVERED', async () => {
  const delivery = await delivered();
  const query = buildDeliveryHandoffQuery(delivery);
  const params = new URLSearchParams(query);
  assert.equal(params.get('awardId'), AWARD_ID);
  assert.equal(params.get('ref'), delivery.uploadedDeliverable.deliverableRef);
  assert.equal(params.get('hash'), delivery.uploadedDeliverable.deliverableHash);
  assert.equal(params.get('file'), 'report.md');
  assert.equal(query.includes(delivery.uploadedDeliverable.deliverableRef), true);
  // No byte content of any kind travels in the link.
  assert.equal(query.length < 300, true);

  const otherProfileWorkspace = workspace();
  const metadata = parseDeliveryHandoffQuery(query, otherProfileWorkspace);
  const imported = importDeliveryHandoffLink({ workspace: otherProfileWorkspace, metadata });
  assert.equal(imported.uploadedDeliverable.deliverableRef, delivery.uploadedDeliverable.deliverableRef);
  assert.equal(imported.uploadedDeliverable.deliverableBytes, undefined);
  assert.equal(imported.retrievedByBuyer, false);
  assert.equal(workspaceStatusWithDelivery(otherProfileWorkspace, imported), 'DELIVERED');

  // Imported metadata never substitutes for a real Buyer Swarm retrieval.
  const retrieved = await retrieveProcurementDeliverable({
    workspace: otherProfileWorkspace, delivery: imported, buyer: BUYER,
    swarmClient: { async downloadData() { return new Uint8Array(delivery.uploadedDeliverable.deliverableBytes); } },
  });
  assert.equal(retrieved.buyerVerification.hashEquality, true);
  assert.equal(retrieved.retrievedByBuyer, true);
});

test('handoff link import rejects a missing/malformed/mismatched query without fabricating DELIVERED', async () => {
  const delivery = await delivered();
  const query = buildDeliveryHandoffQuery(delivery);
  const ws = workspace();

  assert.equal(parseDeliveryHandoffQuery(undefined, ws), undefined);
  assert.equal(parseDeliveryHandoffQuery('', ws), undefined);
  assert.equal(parseDeliveryHandoffQuery('ref=onlyref', ws), undefined);

  const badHash = query.replace(delivery.uploadedDeliverable.deliverableHash, '0xnothex');
  assert.equal(parseDeliveryHandoffQuery(badHash, ws), undefined);

  const badRef = query.replace(delivery.uploadedDeliverable.deliverableRef, 'not-hex-ref!!');
  assert.equal(parseDeliveryHandoffQuery(badRef, ws), undefined);

  const wrongAward = query.replace(AWARD_ID, `0x${'99'.repeat(32)}`);
  assert.equal(parseDeliveryHandoffQuery(wrongAward, ws), undefined);

  assert.equal(importDeliveryHandoffLink({ workspace: ws, metadata: undefined }), undefined);
});

test('fetchDeliverableForDownload re-downloads from Swarm, re-verifies the hash, and never touches localStorage', async () => {
  const delivery = await delivered();
  const originalBytes = delivery.uploadedDeliverable.deliverableBytes;
  let downloadCount = 0;
  const swarmClient = {
    async downloadData() { downloadCount += 1; return new Uint8Array(originalBytes); },
  };
  const file = await fetchDeliverableForDownload({ delivery, swarmClient });
  assert.equal(downloadCount, 1);
  assert.deepEqual(file.bytes, originalBytes);
  assert.equal(file.fileName, 'report.md');
  assert.equal(file.mediaType, 'text/markdown');
});

test('fetchDeliverableForDownload refuses to expose bytes that fail hash re-verification', async () => {
  const delivery = await delivered();
  const swarmClient = { async downloadData() { return Uint8Array.of(0xba, 0xd0); } };
  await assert.rejects(fetchDeliverableForDownload({ delivery, swarmClient }), /integrity verification/);
});
