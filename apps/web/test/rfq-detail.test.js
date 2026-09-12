import assert from 'node:assert/strict';
import test from 'node:test';
import { buildOpenQuotePredicate, buildQuoteCreateParameters, buildRfqCreateParameters } from '@shadowbid/shared/arkiv';
import { ExpirationTime } from '@arkiv-network/sdk';
import {
  loadRfqDetail,
  prepareAwardAttempt,
  prepareQuoteAttempt,
  submitQuoteAttempt,
} from '../src/application/rfq-detail.js';

const RFQ_ID = `0x${'11'.repeat(32)}`;
const QUOTE_ID = `0x${'22'.repeat(32)}`;
const BUYER = '0x490b01048Af9878434727daF2C3291D2ff8a67B0';
const SELLER = '0x4A643d1340F779e5A58a5413eD8908F7e8DC519E';

function entityType(predicate) {
  return predicate.expressions.find(expression => expression.name === 'entity_type').value.value;
}

function fixture() {
  const rfqParameters = buildRfqCreateParameters({
    rfqId: RFQ_ID,
    buyer: BUYER,
    title: 'Audit production vault',
    shortDescription: 'Review authorization and accounting.',
    requiredDelivery: ['Find exploitable issues', 'Recommend fixes'],
    maxBudget: 500_000n,
    maxEtaMinutes: 30n,
    createdAt: 1n,
    expires: ExpirationTime.fromMinutes(30),
    specificationRef: 'a'.repeat(64),
    specificationHash: `0x${'66'.repeat(32)}`,
  });
  const quoteParameters = buildQuoteCreateParameters({
    quoteId: QUOTE_ID,
    rfqId: RFQ_ID,
    seller: SELLER,
    price: 250_000n,
    etaMinutes: 10n,
    createdAt: 2n,
    expires: ExpirationTime.fromMinutes(5),
  });
  const rfqEntity = {
    key: 'rfq-key',
    expiresAt: 200n,
    attributes: rfqParameters.attributes,
    toJson: () => JSON.parse(new TextDecoder().decode(rfqParameters.payload)),
  };
  const quoteEntity = { key: 'quote-key', expiresAt: 150n, attributes: quoteParameters.attributes };
  const predicates = [];
  const client = {
    async getBlockNumber() { return 100n; },
    select() {
      let predicate;
      return {
        where(value) { predicate = value; predicates.push(value); return this; },
        limit() { return this; },
        async fetch() {
          const entities = entityType(predicate) === 'rfq' ? [rfqEntity] : [quoteEntity];
          return { entities, blockNumber: 100n, hasNextPage: () => false };
        },
      };
    },
  };
  return { client, predicates };
}

test('RFQ detail reads public payload and native expiries, then uses the canonical eligible Quote query', async () => {
  const { client, predicates } = fixture();
  const detail = await loadRfqDetail(client, RFQ_ID);
  assert.equal(detail.title, 'Audit production vault');
  assert.deepEqual(detail.requiredDelivery, ['Find exploitable issues', 'Recommend fixes']);
  assert.equal(detail.expiresAtBlock, 200n);
  assert.equal(detail.quotes[0].quoteId, QUOTE_ID);
  assert.equal(detail.quotes[0].expiresAtBlock, 150n);
  assert.equal(detail.quotes[0].priceLabel, '0.25');
  assert.deepEqual(predicates[1], buildOpenQuotePredicate({ rfqId: RFQ_ID, budget: 500_000n, maxEtaMinutes: 30n }));
});

test('Quote preparation enforces the real RFQ budget and ETA before delegating to publishSellerQuote', async () => {
  const rfq = { rfqId: RFQ_ID, maxBudget: 500_000n, budgetLabel: '0.5', maxEtaMinutes: 30n };
  assert.throws(() => prepareQuoteAttempt({ price: '0.6', eta: '10', lifetime: '5' }, rfq, SELLER), /at most/);
  assert.throws(() => prepareQuoteAttempt({ price: '0.2', eta: '31', lifetime: '5' }, rfq, SELLER), /at most/);
  const attempt = prepareQuoteAttempt({ price: '0.25', eta: '10', lifetime: '1' }, rfq, SELLER);
  const calls = [];
  const result = await submitQuoteAttempt(attempt, {
    sellerArkivWriter: {
      owner: SELLER,
      async createQuote(input) { calls.push(input); return { entityKey: 'quote-key', txHash: 'quote-tx', expiresAt: 130n }; },
    },
    arkivPublicClient: {
      select() { return { where() { return this; }, limit() { return this; }, async fetch() { return { entities: [] }; } }; },
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].rfqId, RFQ_ID);
  assert.equal(calls[0].price, 250_000n);
  assert.equal(result.quoteId, attempt.quoteId);
});

test('Award preparation retains a separate awardId and only accepts a Quote in current eligible results', () => {
  const quote = { quoteId: QUOTE_ID };
  const rfq = { rfqId: RFQ_ID, buyer: BUYER, quotes: [quote] };
  const attempt = prepareAwardAttempt(rfq, quote);
  assert.match(attempt.awardId, /^0x[0-9a-f]{64}$/);
  assert.notEqual(attempt.awardId, RFQ_ID);
  assert.equal(attempt.terms.rfqId, RFQ_ID);
  assert.equal(attempt.terms.selectedQuoteId, QUOTE_ID);
  assert.throws(() => prepareAwardAttempt(rfq, { quoteId: `0x${'33'.repeat(32)}` }), /active eligible/);
});
