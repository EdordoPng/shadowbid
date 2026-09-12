import assert from 'node:assert/strict';
import test from 'node:test';
import { buildQuoteCreateParameters, buildRfqCreateParameters } from '@shadowbid/shared/arkiv';
import { AVALANCHE_ESCROW_STATE } from '@shadowbid/shared/procurement';
import { ExpirationTime } from '@arkiv-network/sdk';
import { connectFujiBuyerWallet, avalancheFuji } from '../src/application/avalanche.js';
import { loadProcurementWorkspace } from '../src/application/procurement-workspace.js';

const RFQ_ID = `0x${'11'.repeat(32)}`;
const QUOTE_ID = `0x${'22'.repeat(32)}`;
const AWARD_ID = `0x${'33'.repeat(32)}`;
const BUYER = '0x490b01048Af9878434727daF2C3291D2ff8a67B0';
const SELLER = '0x4A643d1340F779e5A58a5413eD8908F7e8DC519E';
const SPECIFICATION_REF = 'a'.repeat(64);
const SPECIFICATION_HASH = `0x${'66'.repeat(32)}`;

function entityType(predicate) {
  return predicate.expressions.find(expression => expression.name === 'entity_type').value.value;
}

function fixtures() {
  const rfqParameters = buildRfqCreateParameters({
    rfqId: RFQ_ID, buyer: BUYER, title: 'Audit vault', maxBudget: 500_000n,
    maxEtaMinutes: 30n, createdAt: 1n, expires: ExpirationTime.fromDays(1),
    specificationRef: SPECIFICATION_REF, specificationHash: SPECIFICATION_HASH,
  });
  const quoteParameters = buildQuoteCreateParameters({
    quoteId: QUOTE_ID, rfqId: RFQ_ID, seller: SELLER, price: 250_000n,
    etaMinutes: 10n, createdAt: 2n, expires: ExpirationTime.fromDays(1),
  });
  const entities = {
    rfq: { key: 'rfq-key', attributes: rfqParameters.attributes, toJson: () => JSON.parse(new TextDecoder().decode(rfqParameters.payload)) },
    quote: { key: 'quote-key', attributes: quoteParameters.attributes },
    award: { key: 'award-key', attributes: {
      rfq_id: { value: RFQ_ID }, quote_id: { value: QUOTE_ID }, buyer: { value: BUYER },
      seller: { value: SELLER }, amount: { value: 250_000n }, deadline: { value: 1_900_000_000n },
      settlement_asset: { value: 'usdc' }, status: { value: 'pending_funding' },
    } },
  };
  return {
    select() {
      let predicate;
      return {
        where(value) { predicate = value; return this; },
        limit() { return this; },
        async fetch() { return { entities: [entities[entityType(predicate)]] }; },
      };
    },
  };
}

test('Workspace derives AWARDED then FUNDED from the same real Award commitment and Fuji escrow state', async () => {
  const arkivPublicClient = fixtures();
  let stored = { state: AVALANCHE_ESCROW_STATE.NONE, termsHash: `0x${'00'.repeat(32)}` };
  const fujiPublicClient = { async readContract() { return stored; } };
  const awarded = await loadProcurementWorkspace({ arkivPublicClient, fujiPublicClient, awardId: AWARD_ID });
  assert.equal(awarded.status, 'AWARDED');
  assert.equal(awarded.procurementId, AWARD_ID);
  assert.equal(awarded.award.amount, 250_000n);
  assert.equal(awarded.amountLabel, '0.25');
  assert.equal(awarded.quoteEtaMinutes, 10n);
  assert.equal(awarded.rfq.specificationRef, SPECIFICATION_REF);

  stored = { state: AVALANCHE_ESCROW_STATE.FUNDED, termsHash: awarded.commitment.termsHash };
  const funded = await loadProcurementWorkspace({ arkivPublicClient, fujiPublicClient, awardId: AWARD_ID });
  assert.equal(funded.status, 'FUNDED');
  assert.equal(funded.context.escrowState, AVALANCHE_ESCROW_STATE.FUNDED);

  stored = { state: AVALANCHE_ESCROW_STATE.RELEASED, termsHash: awarded.commitment.termsHash };
  const settled = await loadProcurementWorkspace({ arkivPublicClient, fujiPublicClient, awardId: AWARD_ID });
  assert.equal(settled.status, 'SETTLED');
  assert.equal(settled.context.escrowState, AVALANCHE_ESCROW_STATE.RELEASED);
});

test('Fuji wallet composition switches the authorized Buyer without exposing credentials', async () => {
  let chainId = '0x1';
  const methods = [];
  const provider = {
    async request({ method, params }) {
      methods.push(method);
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [BUYER];
      if (method === 'eth_chainId') return chainId;
      if (method === 'wallet_switchEthereumChain') { chainId = params[0].chainId; return null; }
      throw new Error(`Unexpected method ${method}`);
    },
  };
  const session = await connectFujiBuyerWallet(provider, BUYER);
  assert.equal(session.owner.toLowerCase(), BUYER.toLowerCase());
  assert.equal(session.walletClient.chain.id, avalancheFuji.id);
  assert.ok(methods.includes('wallet_switchEthereumChain'));
  await assert.rejects(connectFujiBuyerWallet(provider, SELLER), /Buyer/);
});
