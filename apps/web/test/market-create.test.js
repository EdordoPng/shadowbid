import assert from 'node:assert/strict';
import test from 'node:test';
import { buildRfqCreateParameters, readRfqPayload, createBuyerArkivWriter } from '@shadowbid/shared/arkiv';
import { hashWorkBytes } from '@shadowbid/shared/work-capsule';
import { ExpirationTime } from '@arkiv-network/sdk';
import { buildMarketPredicate, discoverMarketRequests, parseBudget, parseEta } from '../src/application/market.js';
import { prepareRequest, submitRequestAttempt } from '../src/application/create-request.js';
import { assertBuyerSession, connectBuyerWallet } from '../src/application/buyer-wallet.js';
import { arkivChain } from '../src/application/market.js';
const buyer = '0x490b01048Af9878434727daF2C3291D2ff8a67B0';
const otherBuyer = '0xEAAD2aaC9cdFE74F45F95C74E87b981561BcEbaC';
const fields = { title: 'Review payment contract', serviceType: 'security_review', shortDescription: 'Review security', requiredDelivery: 'Identify vulnerabilities\nRecommend fixes', budget: '0.123456', maxEta: '30', lifetime: '30' };
const bytes = Uint8Array.of(239, 187, 191, 65, 13, 10, 32, 195, 169);
function scenario({ storageFail = false, publicationFail = false, readbackMissing = false } = {}) {
  const state = { storageFail, publicationFail, readbackMissing, uploads: 0, writes: 0, entity: undefined };
  const publicClient = { select() { return { where() { return this; }, limit() { return this; }, async fetch() { return { entities: state.entity && !state.readbackMissing ? [state.entity] : [] }; } }; } };
  const walletClient = { account: { address: buyer }, async createEntity(p) {
    state.writes++;
    if (state.publicationFail) throw new Error('Rejected');
    const payload = JSON.parse(new TextDecoder().decode(p.payload));
    state.entity = { key: 'key', attributes: p.attributes, toJson: () => payload };
    return { entityKey: 'key', txHash: 'hash' };
  } };
  return { state, arkivPublicClient: publicClient, buyerArkivWriter: createBuyerArkivWriter({ walletClient, buyer }), swarmClient: { async uploadData(actual) { state.uploads++; assert.deepEqual(actual, bytes); if (state.storageFail) throw new Error('Storage unavailable'); return { reference: 'a'.repeat(64) }; } } };
}
test('request preserves UTF-8 BOM, CRLF and exact bytes/hash and public metadata through the existing writer', async () => {
  const attempt = prepareRequest(fields, bytes, buyer), s = scenario(), stages = [];
  const result = await submitRequestAttempt(attempt, { ...s, onStage: x => stages.push(x) });
  assert.equal(s.state.uploads, 1); assert.equal(s.state.writes, 1);
  assert.equal(result.specificationHash, hashWorkBytes(bytes));
  assert.deepEqual(s.state.entity.toJson().requiredDelivery, ['Identify vulnerabilities', 'Recommend fixes']);
  assert.equal(s.state.entity.toJson().shortDescription, fields.shortDescription);
  assert.equal(s.state.entity.attributes.shortDescription, undefined);
  assert.equal(s.state.entity.attributes.buyer.value.toLowerCase(), buyer.toLowerCase());
  assert.deepEqual(stages, ['Storing specification', 'Publishing Request', 'Request live']);
});
test('storage failure never publishes; retry preserves the Request ID', async () => {
  const a = prepareRequest(fields, bytes, buyer), s = scenario({ storageFail: true }), id = a.terms.rfqId;
  await assert.rejects(submitRequestAttempt(a, s)); assert.equal(s.state.writes, 0);
  s.state.storageFail = false; await submitRequestAttempt(a, s); assert.equal(a.terms.rfqId, id);
});
test('publication retry reuses storage, hash and ID without a second Swarm upload', async () => {
  const a = prepareRequest(fields, bytes, buyer), s = scenario({ publicationFail: true });
  await assert.rejects(submitRequestAttempt(a, s)); const hash = a.uploaded.specificationHash;
  s.state.publicationFail = false; await submitRequestAttempt(a, s);
  assert.equal(s.state.uploads, 1); assert.equal(a.uploaded.specificationHash, hash);
});
test('readback lag never reports success and confirmation retry does not write again', async () => {
  const a = prepareRequest(fields, bytes, buyer), s = scenario({ readbackMissing: true }), stages = [];
  await assert.rejects(submitRequestAttempt(a, { ...s, onStage: x => stages.push(x) }));
  assert.ok(!stages.includes('Request live'));
  s.state.readbackMissing = false; await submitRequestAttempt(a, s);
  assert.equal(s.state.uploads, 1); assert.equal(s.state.writes, 1);
});
test('a different Buyer cannot resume an attempt', async () => {
  const a = prepareRequest(fields, bytes, buyer), s = scenario();
  await assert.rejects(submitRequestAttempt(a, { ...s, buyerArkivWriter: { owner: '0x' + '1'.repeat(40) } }));
  assert.equal(s.state.uploads, 0);
});
test('USDC parsing is exact and rejects rounding, scientific notation and invalid ETA', () => {
  assert.equal(parseBudget('0.123456'), 123456n);
  for (const value of ['0.1234567', '-1', '1e3', '', 'NaN']) assert.throws(() => parseBudget(value));
  for (const value of ['0', '-1', '1.1', '18446744073709551616']) assert.throws(() => parseEta(value));
  assert.throws(() => prepareRequest({ ...fields, serviceType: 'research' }, bytes, buyer));
});
test('RFQ optional metadata leaves the old payload format unchanged', () => {
  const a = prepareRequest(fields, bytes, buyer);
  const p = buildRfqCreateParameters({ ...a.terms, buyer, createdAt: 1n, shortDescription: undefined, requiredDelivery: undefined });
  assert.deepEqual(JSON.parse(new TextDecoder().decode(p.payload)), { title: fields.title });
  assert.throws(() => buildRfqCreateParameters({ ...a.terms, buyer, createdAt: 1n, requiredDelivery: [null] }));
  assert.deepEqual(a.terms.expires, ExpirationTime.fromMinutes(30));
  assert.equal(readRfqPayload({ toJson: () => ({ title: 'old' }) }).title, 'old');
});
test('Market delegates all filters to Arkiv and follows native pagination', async () => {
  const calls = []; const a = prepareRequest(fields, bytes, buyer);
  const params = buildRfqCreateParameters({ ...a.terms, buyer, createdAt: 1n });
  const entity = { expiresAt: 120n, attributes: params.attributes, toJson: () => ({ title: '<script>not HTML</script>' }) };
  const second = { entities: [], blockNumber: 100n, hasNextPage: () => false };
  const first = { entities: [entity], blockNumber: 100n, hasNextPage: () => true, next: async () => second };
  const quoteSecond = { entities: [{ key: 'q3' }], blockNumber: 100n, hasNextPage: () => false };
  const quoteFirst = { entities: [{ key: 'q1' }, { key: 'q2' }], blockNumber: 100n, hasNextPage: () => true, next: async () => quoteSecond };
  const client = { select(x) { calls.push(x); const isQuoteCount = x.key === true && Object.keys(x).length === 1; return { where(x) { calls.push(x); return this; }, limit(x) { calls.push(x); return this; }, atBlock(x) { calls.push(x); return this; }, async fetch() { return isQuoteCount ? quoteFirst : first; } }; } };
  const filters = { serviceType: 'security_review', maxBudget: '0.5', maxEta: '30', openOnly: true };
  const page = await discoverMarketRequests(client, filters);
  assert.deepEqual(calls[1], buildMarketPredicate(filters));
  const serialized = JSON.stringify(calls[1], (_, v) => typeof v === 'bigint' ? String(v) : v);
  for (const name of ['entity_type', 'settlement_asset', 'service_type', 'max_budget', 'max_eta_minutes', 'status']) assert.ok(serialized.includes(name));
  assert.equal(calls[1].expressions.some(expression => expression.name === 'buyer'), false);
  assert.equal(page.rows[0].title, '<script>not HTML</script>');
  assert.equal(page.rows[0].activeQuotes, 3);
  assert.equal(page.rows[0].expiresAtBlock, 120n);
  assert.equal(page.rows[0].snapshotBlock, 100n);
  assert.deepEqual((await page.next()).rows, []);
  assert.ok(!JSON.stringify(buildMarketPredicate({ openOnly: false })).includes('status'));
});

test('optional Buyer filter is included in the Arkiv RFQ predicate', () => {
  const predicate = buildMarketPredicate({ buyer, openOnly: true });
  const buyerClause = predicate.expressions.find(expression => expression.name === 'buyer');
  assert.equal(buyerClause.operator, '=');
  assert.equal(buyerClause.value.type, 'addr');
  assert.equal(buyerClause.value.value.toLowerCase(), buyer.toLowerCase());
});

function buyerDiscoveryClient(rawPages) {
  return {
    select(selection) {
      const quoteCount = selection.key === true && Object.keys(selection).length === 1;
      let predicate;
      return {
        where(value) { predicate = value; return this; },
        limit() { return this; },
        atBlock() { return this; },
        async fetch() {
          if (quoteCount) return { entities: [], blockNumber: 100n, hasNextPage: () => false };
          const expectedBuyer = predicate.expressions.find(expression => expression.name === 'buyer')?.value.value;
          const pages = rawPages.map(entities => entities.filter(entity => !expectedBuyer || entity.attributes.buyer.value.toLowerCase() === expectedBuyer.toLowerCase()));
          const pageAt = index => ({
            entities: pages[index],
            blockNumber: 100n,
            hasNextPage: () => index + 1 < pages.length,
            next: async () => pageAt(index + 1),
          });
          return pageAt(0);
        },
      };
    },
  };
}

function activityRfq(owner, suffix, title) {
  const attempt = prepareRequest(fields, bytes, owner);
  const parameters = buildRfqCreateParameters({ ...attempt.terms, rfqId: `0x${suffix.repeat(64)}`, buyer: owner, createdAt: 1n });
  return { expiresAt: 120n, attributes: parameters.attributes, toJson: () => ({ title }) };
}

test('Buyer RFQ discovery excludes other Buyers and preserves Arkiv pagination', async () => {
  const firstOwned = activityRfq(buyer, '1', 'First owned Request');
  const wrongBuyer = activityRfq(otherBuyer, '2', 'Another Buyer Request');
  const secondOwned = activityRfq(buyer, '3', 'Second owned Request');
  const page = await discoverMarketRequests(buyerDiscoveryClient([[firstOwned, wrongBuyer], [secondOwned]]), { buyer, openOnly: true });
  assert.deepEqual(page.rows.map(row => row.title), ['First owned Request']);
  assert.deepEqual((await page.next()).rows.map(row => row.title), ['Second owned Request']);
});

test('Buyer RFQ discovery handles an empty Arkiv result', async () => {
  const page = await discoverMarketRequests(buyerDiscoveryClient([[activityRfq(otherBuyer, '4', 'Not owned')]]), { buyer, openOnly: true });
  assert.deepEqual(page.rows, []);
  assert.equal(page.next, undefined);
});

test('Market never projects an RFQ whose authoritative Arkiv expiry has passed', async () => {
  const a = prepareRequest(fields, bytes, buyer);
  const params = buildRfqCreateParameters({ ...a.terms, buyer, createdAt: 1n });
  const expired = { expiresAt: 100n, attributes: params.attributes, toJson: () => ({ title: 'Expired' }) };
  const client = { select() { return { where() { return this; }, limit() { return this; }, async fetch() { return { entities: [expired], blockNumber: 100n, hasNextPage: () => false }; } }; } };
  const page = await discoverMarketRequests(client, { openOnly: true });
  assert.deepEqual(page.rows, []);
});
test('browser wallet composition accepts only a real authorized account on the configured chain', async () => {
  await assert.rejects(connectBuyerWallet(undefined), /Wallet unavailable/);
  const methods = [];
  const provider = { async request({ method }) { methods.push(method); return method === 'eth_chainId' ? `0x${arkivChain.id.toString(16)}` : [buyer]; } };
  const writer = await connectBuyerWallet(provider);
  assert.equal(writer.owner.toLowerCase(), buyer.toLowerCase());
  assert.equal(typeof writer.createRfq, 'function');
  assert.equal(typeof writer.createQuote, 'function');
  assert.equal(typeof writer.createAward, 'function');
  assert.deepEqual(methods, ['eth_requestAccounts', 'eth_chainId', 'eth_accounts', 'eth_chainId']);
  await assert.rejects(assertBuyerSession({ request: async ({ method }) => method === 'eth_chainId' ? '0x1' : [buyer] }, buyer), /network/);
  await assert.rejects(assertBuyerSession({ request: async ({ method }) => method === 'eth_chainId' ? '0x1' : [] }, buyer), /account changed/);
});

test('non-UTF-8 files are rejected before storage without altering the frozen text path', () => {
  assert.throws(() => prepareRequest(fields, Uint8Array.of(255, 128), buyer), /UTF-8/);
});
