import { createPublicClient } from '@arkiv-network/sdk';
import { tiramisu } from '@arkiv-network/sdk/chains';
import { addr, str, u64, u256 } from '@arkiv-network/sdk/attr';
import { and, eq, lte } from '@arkiv-network/sdk/query';
import { http, formatUnits, parseUnits } from 'viem';
import {
  ENTITY_TYPE,
  ENTITY_STATUS,
  SERVICE_TYPE,
  SETTLEMENT_ASSET,
  queryActiveQuotesByRfq,
} from '@shadowbid/shared/arkiv';

// Same event-confirmed chain/config as the Slice 4 diagnostics; public data only.
export const arkivChain = tiramisu;
export function createMarketClient() {
  return createPublicClient({ chain: arkivChain, transport: http(undefined, { timeout: 15000, retryCount: 1 }) });
}
export const service = Object.freeze({ value: SERVICE_TYPE, label: 'Security Review' });
export const ARKIV_BLOCK_TIME_SECONDS = 2;
export function readMarketBlock(arkivPublicClient) {
  return arkivPublicClient.getBlockNumber();
}
export function parseBudget(value) {
  if (!/^(0|[1-9]\d*)(\.\d{1,6})?$/.test(value)) throw new TypeError('Enter USDC with up to 6 decimal places.');
  const amount = parseUnits(value, 6);
  u256(amount);
  return amount;
}
export function parseEta(value) {
  if (!/^[1-9]\d*$/.test(value)) throw new TypeError('Enter a positive whole number of minutes.');
  const minutes = BigInt(value);
  u64(minutes);
  return minutes;
}
export function formatBudget(value) { return formatUnits(value, 6); }
export function buildMarketPredicate({ serviceType = '', maxBudget = '', maxEta = '', openOnly = true, buyer = '' } = {}) {
  if (serviceType !== '' && serviceType !== SERVICE_TYPE) throw new TypeError('Unsupported service.');
  const clauses = [eq('entity_type', str(ENTITY_TYPE.RFQ)), eq('settlement_asset', str(SETTLEMENT_ASSET))];
  if (buyer) clauses.push(eq('buyer', addr(buyer)));
  if (serviceType) clauses.push(eq('service_type', str(serviceType)));
  if (maxBudget !== '') clauses.push(lte('max_budget', u256(parseBudget(maxBudget))));
  if (maxEta !== '') clauses.push(lte('max_eta_minutes', u64(parseEta(maxEta))));
  if (openOnly) clauses.push(eq('status', str(ENTITY_STATUS.OPEN)));
  return and(...clauses);
}
async function countActiveQuotes(arkivPublicClient, rfqId, atBlock) {
  let page = await queryActiveQuotesByRfq(
    arkivPublicClient,
    { rfqId },
    { atBlock },
  );
  let count = page.entities.length;
  while (page.hasNextPage()) {
    page = await page.next();
    count += page.entities.length;
  }
  return count;
}
async function projectPage(page, arkivPublicClient) {
  const liveEntities = page.entities.filter(entity => entity.expiresAt > page.blockNumber);
  const quoteCounts = await Promise.all(
    liveEntities.map(entity => countActiveQuotes(
      arkivPublicClient,
      entity.attributes.rfq_id.value,
      page.blockNumber,
    )),
  );
  const rows = liveEntities.map((entity, index) => {
    const a = entity.attributes;
    const payload = entity.toJson();
    return Object.freeze({
      rfqId: a.rfq_id.value, title: typeof payload.title === 'string' ? payload.title : 'Untitled request',
      shortDescription: typeof payload.shortDescription === 'string' ? payload.shortDescription : '',
      service: a.service_type.value === SERVICE_TYPE ? service.label : a.service_type.value,
      budget: formatBudget(a.max_budget.value), maxEta: String(a.max_eta_minutes.value),
      activeQuotes: quoteCounts[index],
      expiresAtBlock: entity.expiresAt,
      snapshotBlock: page.blockNumber,
      status: String(a.status.value).toUpperCase(), buyer: a.buyer.value,
    });
  });
  return {
    rows,
    snapshotBlock: page.blockNumber,
    next: page.hasNextPage()
      ? async () => projectPage(await page.next(), arkivPublicClient)
      : undefined,
  };
}
export async function discoverMarketRequests(arkivPublicClient, filters) {
  const page = await arkivPublicClient.select({
    key: true,
    expiresAt: true,
    attributes: true,
    payload: true,
  })
    .where(buildMarketPredicate(filters)).limit(50).fetch();
  return projectPage(page, arkivPublicClient);
}
