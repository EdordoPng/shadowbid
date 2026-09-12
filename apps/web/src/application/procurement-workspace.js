import { queryAwardById, queryQuoteById } from '@shadowbid/shared/arkiv';
import {
  AVALANCHE_ESCROW_STATE,
  createProcurementContext,
  deriveProcurementStatus,
} from '@shadowbid/shared/procurement';
import { formatUnits } from 'viem';
import { fundAward, readAwardCommitmentInputs } from '../fund-award.js';
import { readBackBuyerRequest } from '../buyer-request.js';
import { formatBudget, service } from './market.js';
import {
  FUJI_ESCROW_ADDRESS,
  FUJI_USDC_ADDRESS,
  FUJI_USDC_DECIMALS,
  escrowAbi,
  usdcAbi,
} from './avalanche.js';

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
  const [rfq, quotePage, commitment] = await Promise.all([
    readBackBuyerRequest({ arkivPublicClient, rfqId: award.rfqId }),
    queryQuoteById(arkivPublicClient, { quoteId: award.quoteId }),
    readAwardCommitmentInputs({ arkivPublicClient, awardId, token: FUJI_USDC_ADDRESS }),
  ]);
  if (!rfq) throw new Error(`RFQ ${award.rfqId} referenced by this Award is unavailable.`);
  const stored = await fujiPublicClient.readContract({
    address: FUJI_ESCROW_ADDRESS,
    abi: escrowAbi,
    functionName: 'getEscrow',
    args: [commitment.procurementId],
  });
  const escrowState = Number(stored.state);
  if ((escrowState === AVALANCHE_ESCROW_STATE.FUNDED || escrowState === AVALANCHE_ESCROW_STATE.RELEASED) &&
      stored.termsHash !== commitment.termsHash) {
    throw new Error('Fuji escrow termsHash does not match the canonical Award commitment.');
  }
  if (escrowState === AVALANCHE_ESCROW_STATE.REFUNDED) {
    throw new Error('This procurement was refunded and is outside the 5E happy path.');
  }
  const quote = quotePage.entities[0];
  const context = createProcurementContext({
    rfqId: award.rfqId,
    quoteId: award.quoteId,
    awardId,
    buyer: award.buyer,
    seller: award.seller,
    token: commitment.token,
    amount: award.amount,
    deadline: award.deadline,
    specificationRef: rfq.specificationRef,
    specificationHash: rfq.specificationHash,
    termsHash: commitment.termsHash,
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
    serviceLabel: rfq.serviceType === service.value ? service.label : rfq.serviceType,
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
