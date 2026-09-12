import { queryAwardById, queryQuoteById } from '@shadowbid/shared/arkiv';
import { buildEscrowCommitmentInput, procurementIdFromAwardId } from '@shadowbid/shared/commitment';
import {
  AVALANCHE_ESCROW_STATE,
  createProcurementContext,
  deriveProcurementStatus,
} from '@shadowbid/shared/procurement';
import { formatUnits } from 'viem';
import { fundAward } from '../fund-award.js';
import { readBackBuyerRequest } from '../buyer-request.js';
import { formatBudget, service } from './market.js';
import {
  FUJI_ESCROW_ADDRESS,
  FUJI_USDC_ADDRESS,
  FUJI_USDC_DECIMALS,
  escrowAbi,
  usdcAbi,
} from './avalanche.js';

/**
 * Award = durable procurement identity (Arkiv, write-once). Fuji escrow =
 * authoritative economic state, read independently of everything else so a
 * FUNDED/RELEASED/REFUNDED escrow always renders correctly. RFQ and Quote
 * are ephemeral Arkiv market state (short native TTL) and become optional
 * enrichment once an Award exists: their absence degrades display fields
 * only, never the Award/Fuji lifecycle itself. Never fabricated when
 * missing — `rfq`/`commitment`/`serviceLabel` are simply undefined.
 */
export async function loadProcurementWorkspace({ arkivPublicClient, fujiPublicClient, awardId }) {
  const awardPage = await queryAwardById(arkivPublicClient, { awardId });
  const entity = awardPage.entities[0];
  if (!entity) return undefined;
  const attributes = entity.attributes;
  const award = Object.freeze({
    awardId,
    rfqId: attributes.rfq_id.value,
    quoteId: attributes.quote_id.value,
    buyer: attributes.buyer.value,
    seller: attributes.seller.value,
    amount: attributes.amount.value,
    settlementAsset: attributes.settlement_asset.value,
    deadline: attributes.deadline.value,
    status: attributes.status.value,
  });
  const procurementId = procurementIdFromAwardId(awardId);
  const [rfq, quotePage, stored] = await Promise.all([
    readBackBuyerRequest({ arkivPublicClient, rfqId: award.rfqId }).catch(() => undefined),
    queryQuoteById(arkivPublicClient, { quoteId: award.quoteId }).catch(() => undefined),
    fujiPublicClient.readContract({
      address: FUJI_ESCROW_ADDRESS,
      abi: escrowAbi,
      functionName: 'getEscrow',
      args: [procurementId],
    }),
  ]);
  const escrowState = Number(stored.state);
  // PRE-FUND (NONE): the canonical commitment must be independently derived
  // from the RFQ's specificationHash, to know what funding should write
  // on-chain — never a fallback termsHash, never fabricated; simply
  // undefined once the RFQ has expired, so fundProcurement correctly
  // refuses rather than guessing.
  // POST-FUND (FUNDED/RELEASED): the escrow itself is now the authoritative
  // economic commitment — its already-verified termsHash is read straight
  // from Fuji, never re-derived from the (possibly long-expired) RFQ. A
  // naturally expired RFQ must not make an already-funded procurement
  // impossible to release.
  let commitment;
  if (escrowState === AVALANCHE_ESCROW_STATE.FUNDED || escrowState === AVALANCHE_ESCROW_STATE.RELEASED) {
    commitment = Object.freeze({
      procurementId,
      seller: stored.seller,
      token: stored.token,
      amount: stored.amount,
      termsHash: stored.termsHash,
      deadline: stored.deadline,
    });
  } else if (rfq?.specificationHash !== undefined) {
    try {
      commitment = buildEscrowCommitmentInput({ award, token: FUJI_USDC_ADDRESS, specificationHash: rfq.specificationHash });
    } catch {
      commitment = undefined;
    }
  }
  if (escrowState === AVALANCHE_ESCROW_STATE.REFUNDED) {
    throw new Error('This procurement was refunded and is outside the 5E happy path.');
  }
  const quote = quotePage?.entities?.[0];
  const context = createProcurementContext({
    rfqId: award.rfqId,
    quoteId: award.quoteId,
    awardId,
    buyer: award.buyer,
    seller: award.seller,
    token: FUJI_USDC_ADDRESS,
    amount: award.amount,
    deadline: award.deadline,
    specificationRef: rfq?.specificationRef,
    specificationHash: rfq?.specificationHash,
    termsHash: commitment?.termsHash,
    escrowState,
  });
  return Object.freeze({
    award,
    rfq,
    quoteEtaMinutes: quote?.attributes.eta_minutes.value,
    commitment,
    stored,
    context,
    procurementId: context.procurementId,
    status: deriveProcurementStatus(context),
    serviceLabel: rfq === undefined ? undefined : (rfq.serviceType === service.value ? service.label : rfq.serviceType),
    amountLabel: formatUnits(award.amount, FUJI_USDC_DECIMALS),
  });
}

export async function fundProcurement({
  workspace,
  fujiPublicClient,
  fujiWalletClient,
  onStage,
}) {
  if (fujiWalletClient.account.address.toLowerCase() !== workspace.award.buyer.toLowerCase()) {
    throw new Error('Only the Buyer that owns this Award can fund its commitment.');
  }
  if (!workspace.commitment) {
    throw new Error('The original Request is no longer available on Arkiv; the canonical specification required to fund this escrow cannot be reconstructed.');
  }
  return fundAward({
    publicClient: fujiPublicClient,
    walletClient: fujiWalletClient,
    escrowAddress: FUJI_ESCROW_ADDRESS,
    escrowAbi,
    usdcAddress: FUJI_USDC_ADDRESS,
    usdcAbi,
    commitment: workspace.commitment,
    onStage,
  });
}

export function formatAwardAmount(value) {
  return `${formatBudget(value)} USDC`;
}
