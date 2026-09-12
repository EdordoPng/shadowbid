import {
  ARKIV_BLOCK_TIME_SECONDS,
  createMarketClient,
  discoverMarketRequests,
  readMarketBlock,
} from '../application/market.js';
import { connectArkivWallet, assertWalletSession } from '../application/buyer-wallet.js';
import { createWorkStorage } from '../application/work-storage.js';
import { createPublicWorkReader, SWARM_GATEWAY } from '../application/swarm-reader.js';
import { prepareRequest, submitRequestAttempt } from '../application/create-request.js';
import {
  findAwardedProcurementForSeller,
  loadRfqDetail,
  prepareAwardAttempt,
  prepareQuoteAttempt,
  submitAwardAttempt,
  submitQuoteAttempt,
} from '../application/rfq-detail.js';
import {
  avalancheFuji,
  connectFujiBuyerWallet,
  createFujiPublicClient,
  fujiTransactionUrl,
} from '../application/avalanche.js';
import { fundProcurement, loadProcurementWorkspace } from '../application/procurement-workspace.js';
import { computeMarketDisclosure } from './market-disclosure.js';
import {
  buildDeliveryHandoffQuery,
  deliverableStateLabel,
  fetchDeliverableForDownload,
  importDeliveryHandoffLink,
  isSpecificationVerified,
  loadDeliverySession,
  parseDeliveryHandoffQuery,
  prepareDelivery,
  releaseProcurement,
  retrieveProcurementDeliverable,
  saveDeliverySession,
  submitDeliveryAttempt,
  workspaceStatusWithDelivery,
} from '../application/procurement-delivery.js';

const $ = id => document.getElementById(id);
const RFQ_EXPIRED_NOTE = 'Original Request expired from live Arkiv market state.';
const arkivPublicClient = createMarketClient();
const fujiPublicClient = createFujiPublicClient();
const publicWorkReader = createPublicWorkReader();
let walletSession, provider;
let requestAttempt, requestBusy = false, requestCompleted = false;
let nextPage, marketVersion = 0, marketBlock, marketClockBusy = false, marketExpanded = false;
let rfq, rfqVersion = 0, rfqClockBusy = false, rfqRefreshScheduled = false;
let sellerAwardedProcurementId;
let selectedQuoteId, quoteAttempt, quoteBusy = false, awardAttempt, awardBusy = false, awardConfirmed = false;
let expiredQuotes = new Map();
let workspace, workspaceVersion = 0, fundingBusy = false, fundingResult;
let deliverableBlobUrl, deliverableAccessBusy = false;
const verifiedCopyValues = {};
let deliveryRecord, deliveryAttempt, deliveryBusy = false, retrievalBusy = false;
let releaseBusy = false, releaseResult;

const pages = {
  market: ['Market', 'Open requests for short-lived digital work.'],
  'create-request': ['Create Request', 'Define the work, market constraints and request lifetime.'],
  activity: ['My Activity', 'Your Requests, Quotes and active procurements.'],
};

function message(id, text, error = false) {
  $(id).textContent = text;
  $(id).dataset.error = String(error);
}

function route() {
  const key = location.hash.slice(1) || 'market';
  const match = key.match(/^rfq\/(0x[0-9a-f]{64})$/);
  if (match) return { key: 'rfq', rfqId: match[1] };
  const procurement = key.match(/^procurement\/(0x[0-9a-f]{64})(?:\?(.*))?$/);
  return procurement ? { key: 'workspace', awardId: procurement[1], deliveryLinkQuery: procurement[2] } : { key };
}

function shortAddress(address) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function resetCompletedRequest() {
  if (!requestCompleted) return;
  requestAttempt = undefined;
  requestCompleted = false;
  $('request-form').reset();
  $('request-fields').disabled = false;
  $('specification-file').disabled = false;
  $('publish-request').disabled = false;
  $('publish-request').textContent = 'Publish Request';
  $('success-market').hidden = true;
  $('attempt-note').hidden = true;
  message('publish-message', 'Connect your wallet and Swarm ID before publishing.');
  message('specification-note', 'Not selected');
}

function renderPage({ focus = false } = {}) {
  const current = route();
  const page = current.key === 'rfq'
    ? ['RFQ Detail', 'Live eligible Quotes for this Request.']
    : current.key === 'workspace'
      ? ['Procurement Workspace', 'Award and commitment state.']
    : (pages[current.key] ?? ['Page unavailable', 'This page is not available.']);
  $('breadcrumb').textContent = current.key === 'rfq' ? 'Market / RFQ' : current.key === 'workspace' ? 'Market / Procurement' : page[0];
  $('page-title').textContent = page[0];
  $('page-description').textContent = page[1];
  for (const [id, visible] of [
    ['market-view', current.key === 'market'],
    ['create-view', current.key === 'create-request'],
    ['rfq-view', current.key === 'rfq'],
    ['workspace-view', current.key === 'workspace'],
    ['activity-view', current.key === 'activity'],
    ['unknown-view', !pages[current.key] && current.key !== 'rfq' && current.key !== 'workspace'],
  ]) $(id).hidden = !visible;
  $('create-cta').hidden = current.key === 'create-request' || current.key === 'rfq' || current.key === 'workspace';
  for (const link of document.querySelectorAll('[data-page]')) {
    const active = link.dataset.page === current.key ||
      ((current.key === 'create-request' || current.key === 'rfq' || current.key === 'workspace') && link.dataset.page === 'market');
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  document.title = `${page[0]} · ShadowBid`;
  if (focus) $('main').focus();
  if (current.key === 'market') loadMarket();
  if (current.key === 'create-request') resetCompletedRequest();
  if (current.key === 'rfq') loadRfq(current.rfqId);
  if (current.key === 'workspace') loadWorkspace(current.awardId);
}

function filters() {
  const values = new FormData($('market-filters'));
  return {
    serviceType: values.get('serviceType'),
    maxBudget: values.get('maxBudget').trim(),
    maxEta: values.get('maxEta').trim(),
    openOnly: values.has('openOnly'),
  };
}

function appendRows(rows) {
  for (const row of rows) {
    const tr = document.createElement('tr');
    tr.dataset.rfqId = row.rfqId;
    const title = document.createElement('td');
    const link = document.createElement('a');
    link.className = 'market-request-link';
    link.href = `#rfq/${row.rfqId}`;
    const strong = document.createElement('strong');
    strong.textContent = row.title;
    link.append(strong);
    title.append(link);
    if (row.shortDescription) {
      const detail = document.createElement('span');
      detail.className = 'caption muted';
      detail.textContent = row.shortDescription;
      title.append(detail);
    }
    if (walletSession?.owner.toLowerCase() === row.buyer.toLowerCase()) {
      const owner = document.createElement('span');
      owner.className = 'caption';
      owner.textContent = 'Your request';
      title.append(owner);
    }
    tr.append(title);
    for (const [value, className] of [
      [row.service, ''],
      [`${row.budget} USDC`, 'mono'],
      [`${row.maxEta} min`, 'mono'],
      [String(row.activeQuotes), 'mono'],
      ['', 'mono market-countdown'],
      [row.status, 'status-badge market-status'],
    ]) {
      const td = document.createElement('td');
      const span = document.createElement('span');
      span.className = className;
      span.textContent = value;
      if (className.includes('market-countdown')) span.dataset.expiresAtBlock = String(row.expiresAtBlock);
      if (className.includes('market-status') && value === 'OPEN') span.dataset.tone = 'positive';
      td.append(span);
      tr.append(td);
    }
    $('market-rows').append(tr);
  }
  renderMarketCountdowns();
  applyMarketDisclosure();
}

function marketCompactLimit() {
  const raw = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--market-compact-rows'), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 6;
}

/** Purely presentational row disclosure: every fetched Request stays in the
 * DOM and in Arkiv real pagination state. This only toggles which already-
 * loaded rows are visible so the default Market view stays compact. */
function applyMarketDisclosure() {
  const rows = [...$('market-rows').children];
  const { visibleCount, hasHidden, buttonLabel } = computeMarketDisclosure({
    rowCount: rows.length,
    limit: marketCompactLimit(),
    expanded: marketExpanded,
  });
  rows.forEach((row, index) => { row.hidden = index >= visibleCount; });
  const button = $('market-show-more');
  button.hidden = !hasHidden;
  if (hasHidden) {
    button.setAttribute('aria-expanded', String(marketExpanded));
    button.textContent = buttonLabel;
  }
}

function formatRemainingBlocks(blocks) {
  const seconds = Number(blocks) * ARKIV_BLOCK_TIME_SECONDS;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}

function renderMarketCountdowns() {
  if (marketBlock === undefined) return false;
  let expired = false;
  for (const countdown of document.querySelectorAll('.market-countdown')) {
    const remaining = BigInt(countdown.dataset.expiresAtBlock) - marketBlock;
    if (remaining <= 0n) {
      countdown.textContent = 'Checking…';
      const status = countdown.closest('tr').querySelector('.market-status');
      status.textContent = 'UPDATING';
      delete status.dataset.tone;
      expired = true;
    } else countdown.textContent = `≈ ${formatRemainingBlocks(remaining)}`;
  }
  return expired;
}

async function syncMarketClock() {
  if (marketClockBusy || route().key !== 'market') return;
  marketClockBusy = true;
  let expired = false;
  try {
    marketBlock = await readMarketBlock(arkivPublicClient);
    expired = renderMarketCountdowns();
  } catch {
    // Keep the last Arkiv snapshot visible; Refresh exposes persistent failures.
  } finally {
    marketClockBusy = false;
  }
  if (expired) loadMarket();
}

async function loadMarket(more = false) {
  const version = ++marketVersion;
  const next = more ? nextPage : undefined;
  $('load-more').disabled = true;
  if (!more) {
    $('market-rows').replaceChildren();
    $('market-table').hidden = true;
    $('load-more').hidden = true;
    $('market-show-more').hidden = true;
    marketExpanded = false;
    nextPage = undefined;
  }
  message('market-message', 'Loading requests…');
  try {
    const page = next ? await next() : await discoverMarketRequests(arkivPublicClient, filters());
    if (version !== marketVersion || route().key !== 'market') return;
    marketBlock = page.snapshotBlock;
    appendRows(page.rows);
    nextPage = page.next;
    const count = $('market-rows').children.length;
    $('market-table').hidden = count === 0;
    $('load-more').hidden = !nextPage;
    message('market-message', count
      ? `${count} requests loaded · Live market state · Arkiv`
      : (filters().openOnly ? 'No open requests match these filters. New procurement requests will appear here while they are active.' : 'No requests match these filters.'));
  } catch {
    if (version !== marketVersion) return;
    message('market-message', 'Market load failure. Check your connection and filters, then Refresh.', true);
  } finally {
    if (version === marketVersion) $('load-more').disabled = false;
  }
}

function renderConstraints() {
  const constraints = [rfq.serviceLabel, `Max ${rfq.budgetLabel} USDC`, `Delivery ≤ ${rfq.maxEtaMinutes} min`, 'Active only'];
  $('quote-constraints').replaceChildren(...constraints.map(value => {
    const span = document.createElement('span');
    span.className = 'constraint';
    span.textContent = value;
    return span;
  }));
}

function renderExpiredQuotes() {
  $('expired-count').textContent = String(expiredQuotes.size);
  $('recently-expired').hidden = expiredQuotes.size === 0;
  $('expired-quotes').replaceChildren(...[...expiredQuotes.values()].map(quote => {
    const item = document.createElement('div');
    item.className = 'expired-item';
    const seller = document.createElement('span');
    seller.className = 'reference';
    seller.textContent = shortAddress(quote.seller);
    const terms = document.createElement('span');
    terms.className = 'mono';
    terms.textContent = `${quote.priceLabel} USDC · ${quote.etaMinutes} min`;
    const status = document.createElement('span');
    const badge = document.createElement('span');
    badge.className = 'status-badge';
    badge.dataset.tone = 'negative';
    badge.textContent = 'EXPIRED';
    const note = document.createElement('span');
    note.className = 'caption';
    note.textContent = 'Expired naturally';
    status.append(badge, note);
    item.append(seller, terms, status);
    return item;
  }));
}

function quoteRemaining(quote) {
  return quote.expiresAtBlock - rfq.snapshotBlock;
}

function renderSelection() {
  const quote = rfq?.quotes.find(candidate => candidate.quoteId === selectedQuoteId);
  const buyer = walletSession && walletSession.owner.toLowerCase() === rfq?.buyer.toLowerCase();
  const active = quote && quoteRemaining(quote) > 0n;
  $('selected-quote-empty').hidden = Boolean(active);
  $('selected-quote').hidden = !active;
  $('create-award').disabled = !buyer || !active || awardConfirmed || awardBusy;
  if (!active) {
    message('award-message', buyer ? 'Select a valid Quote to continue.' : 'Connect the RFQ Buyer to select a Quote.');
    return;
  }
  $('selected-price').textContent = `${quote.priceLabel} USDC`;
  $('selected-seller').textContent = quote.seller;
  $('selected-eta').textContent = `${quote.etaMinutes} min`;
  $('selected-expiry').dataset.quoteId = quote.quoteId;
  $('selected-expiry').dataset.expiresAtBlock = String(quote.expiresAtBlock);
  $('selected-service').textContent = rfq.serviceLabel;
  $('selected-asset').textContent = quote.settlementAsset.toUpperCase();
  message('award-message', awardConfirmed ? 'Award created from the selected Quote.' : 'Ready to create a separate Buyer-owned Award.');
}

function renderQuoteRows() {
  const isBuyer = walletSession && walletSession.owner.toLowerCase() === rfq.buyer.toLowerCase();
  const selectable = isBuyer && !awardAttempt;
  $('quote-rows').replaceChildren(...rfq.quotes.map(quote => {
    const tr = document.createElement('tr');
    tr.className = 'quote-row';
    tr.dataset.quoteId = quote.quoteId;
    tr.dataset.selectable = String(Boolean(selectable));
    tr.setAttribute('aria-selected', String(quote.quoteId === selectedQuoteId));
    if (selectable) {
      tr.tabIndex = 0;
      tr.setAttribute('role', 'button');
      tr.setAttribute('aria-label', `Select Quote from ${shortAddress(quote.seller)}`);
    }
    const values = [
      [shortAddress(quote.seller), 'reference quote-seller'],
      [`${quote.priceLabel} USDC`, 'mono quote-price'],
      [`${quote.etaMinutes} min`, 'mono'],
      ['', 'mono quote-countdown'],
      ['OPEN', 'status-badge quote-status'],
    ];
    for (const [value, className] of values) {
      const td = document.createElement('td');
      const span = document.createElement('span');
      span.className = className;
      span.textContent = value;
      if (className.includes('quote-countdown')) {
        span.dataset.quoteId = quote.quoteId;
        span.dataset.expiresAtBlock = String(quote.expiresAtBlock);
      }
      td.append(span);
      tr.append(td);
    }
    return tr;
  }));
  $('quotes-table').hidden = rfq.quotes.length === 0;
  message('quotes-message', rfq.quotes.length ? 'Eligible active Quotes returned by Arkiv.' : 'No active Quotes match every constraint.');
  $('quote-count').textContent = `${rfq.quotes.length} ${rfq.quotes.length === 1 ? 'offer matches' : 'offers match'} this request`;
  renderSelection();
  renderQuoteCountdowns();
}

function renderRoleActions() {
  const connected = Boolean(walletSession);
  const isBuyer = connected && walletSession.owner.toLowerCase() === rfq.buyer.toLowerCase();
  const awarded = connected && !isBuyer && Boolean(sellerAwardedProcurementId);
  $('rfq-connect-panel').hidden = connected;
  $('seller-awarded-panel').hidden = !awarded;
  if (awarded) $('open-seller-workspace').href = `#procurement/${sellerAwardedProcurementId}`;
  $('seller-quote-panel').hidden = !connected || isBuyer || awarded;
  $('buyer-award-panel').hidden = !isBuyer;
  renderQuoteRows();
}

/** Award ownership is read live from Arkiv (the durable source of truth),
 * never inferred from local browser state — this is a real query, not a
 * localStorage lookup. Stale-guarded against rfq/wallet changing mid-flight. */
async function refreshSellerAwardedProcurement() {
  const currentRfqId = rfq?.rfqId;
  const owner = walletSession?.owner;
  const isBuyer = owner && owner.toLowerCase() === rfq?.buyer.toLowerCase();
  if (!currentRfqId || !owner || isBuyer) {
    sellerAwardedProcurementId = undefined;
    renderRoleActions();
    return;
  }
  try {
    const awardId = await findAwardedProcurementForSeller({ arkivPublicClient, rfqId: currentRfqId, seller: owner });
    if (route().key !== 'rfq' || rfq?.rfqId !== currentRfqId || walletSession?.owner !== owner) return;
    sellerAwardedProcurementId = awardId;
  } catch {
    if (route().key !== 'rfq' || rfq?.rfqId !== currentRfqId || walletSession?.owner !== owner) return;
    sellerAwardedProcurementId = undefined;
  }
  renderRoleActions();
}

function renderRfq() {
  $('breadcrumb').textContent = `Market / ${rfq.rfqId.slice(0, 10)}…`;
  $('page-title').textContent = rfq.title || 'Untitled request';
  $('page-description').textContent = 'RFQ Detail / Live Quotes';
  $('rfq-status').textContent = String(rfq.status).toUpperCase();
  $('rfq-reference').textContent = rfq.rfqId;
  $('rfq-description').textContent = rfq.shortDescription || 'No public description supplied.';
  $('rfq-metadata').textContent = `${rfq.serviceLabel} · Budget ${rfq.budgetLabel} USDC · Delivery ≤ ${rfq.maxEtaMinutes} min`;
  const requirements = rfq.requiredDelivery.length ? rfq.requiredDelivery : ['See the Work Capsule specification.'];
  $('rfq-requirements').replaceChildren(...requirements.map(value => {
    const li = document.createElement('li');
    li.textContent = value;
    return li;
  }));
  $('rfq-specification-ref').textContent = rfq.specificationRef ? `Reference ${rfq.specificationRef}` : 'No specification reference published';
  $('rfq-specification-title').textContent = rfq.specificationRef ? 'Specification available' : 'Specification unavailable';
  renderConstraints();
  renderExpiredQuotes();
  renderRoleActions();
  refreshSellerAwardedProcurement();
}

async function loadRfq(rfqId, { preserveExpired = false } = {}) {
  const version = ++rfqVersion;
  sellerAwardedProcurementId = undefined;
  if (!preserveExpired) {
    expiredQuotes = new Map();
    selectedQuoteId = undefined;
    quoteAttempt = undefined;
    awardAttempt = undefined;
    awardConfirmed = false;
    $('create-award').textContent = 'Create Award';
    $('award-created').hidden = true;
  }
  message('quotes-message', 'Loading eligible Quotes…');
  try {
    const detail = await loadRfqDetail(arkivPublicClient, rfqId);
    if (version !== rfqVersion || route().rfqId !== rfqId) return;
    if (!detail) {
      $('page-title').textContent = 'Request unavailable';
      $('page-description').textContent = 'This RFQ is expired or cannot be read from Arkiv.';
      $('rfq-view').hidden = true;
      $('unknown-view').hidden = false;
      return;
    }
    rfq = detail;
    if (selectedQuoteId && !rfq.quotes.some(quote => quote.quoteId === selectedQuoteId)) selectedQuoteId = undefined;
    renderRfq();
  } catch {
    if (version !== rfqVersion) return;
    message('quotes-message', 'RFQ load failure. Check the Arkiv connection and retry from Market.', true);
  }
}

function formatDeadline(timestamp) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(Number(timestamp) * 1000));
}

function renderWorkspace() {
  const status = workspaceStatusWithDelivery(workspace, deliveryRecord);
  const funded = status === 'FUNDED' || status === 'DELIVERED' || status === 'SETTLED';
  const delivered = Boolean(deliveryRecord);
  const retrieved = deliveryRecord?.retrievedByBuyer === true;
  const settled = status === 'SETTLED';
  const connectedBuyer = walletSession?.owner.toLowerCase() === workspace.award.buyer.toLowerCase();
  const connectedSeller = walletSession?.owner.toLowerCase() === workspace.award.seller.toLowerCase();
  const connectedOther = walletSession && !connectedBuyer && !connectedSeller;
  for (const key of Object.keys(verifiedCopyValues)) delete verifiedCopyValues[key];
  $('breadcrumb').textContent = `Market / ${workspace.award.rfqId.slice(0, 10)}… / Procurement`;
  $('page-title').textContent = workspace.rfq?.title || 'Procurement';
  $('page-description').textContent = 'Procurement Workspace';
  $('workspace-status').textContent = status;
  $('workspace-status').dataset.tone = funded ? 'positive' : 'accent';
  $('workspace-reference').textContent = workspace.procurementId;
  $('workspace-supporting').textContent = `${workspace.serviceLabel ?? RFQ_EXPIRED_NOTE} · Seller ${shortAddress(workspace.award.seller)} · ${workspace.amountLabel} USDC`;
  $('workspace-price').textContent = `${workspace.amountLabel} USDC`;
  $('workspace-delivery').textContent = workspace.quoteEtaMinutes === undefined ? 'Set by Award deadline' : `${workspace.quoteEtaMinutes} min`;
  $('workspace-deadline').textContent = formatDeadline(workspace.award.deadline);
  $('workspace-service').textContent = workspace.serviceLabel ?? RFQ_EXPIRED_NOTE;
  $('workspace-seller').textContent = workspace.award.seller;
  $('workspace-award-ref').textContent = workspace.award.awardId;
  $('workspace-spec-state').textContent = !workspace.rfq ? RFQ_EXPIRED_NOTE : (workspace.rfq.specificationRef ? 'Stored' : 'Unavailable');
  $('workspace-spec-ref').textContent = workspace.rfq?.specificationRef || 'No reference';
  $('workspace-deliverable-state').textContent = deliverableStateLabel(workspace, deliveryRecord);
  for (const id of ['workspace-deliverable-name-row', 'workspace-deliverable-ref-row', 'workspace-deliverable-hash-row']) $(id).hidden = !delivered;
  if (delivered) {
    $('workspace-deliverable-name').textContent = deliveryRecord.fileName;
    $('workspace-deliverable-ref').textContent = deliveryRecord.uploadedDeliverable.deliverableRef;
    $('workspace-deliverable-hash').textContent = deliveryRecord.uploadedDeliverable.deliverableHash;
  }
  $('commitment-amount').textContent = `${workspace.amountLabel} USDC`;
  $('commitment-status').textContent = settled ? 'Settled' : retrieved ? 'Ready to Release' : funded ? 'FUNDED' : 'Awaiting funding';
  $('commitment-seller').textContent = workspace.award.seller;
  $('verified-award').textContent = shortAddress(workspace.award.awardId);
  verifiedCopyValues['verified-award'] = workspace.award.awardId;
  const specificationVerified = isSpecificationVerified(workspace);
  $('verified-specification-mark').textContent = specificationVerified ? '✓' : '–';
  $('verified-specification-mark').dataset.state = specificationVerified ? 'verified' : 'unavailable';
  $('verified-specification').textContent = !workspace.rfq
    ? 'Original Request expired'
    : (specificationVerified ? shortAddress(workspace.rfq.specificationRef) : 'Reference unavailable');
  $('specification-proof-actions').hidden = !specificationVerified;
  $('specification-proof').hidden = !specificationVerified;
  if (specificationVerified) {
    $('specification-proof').href = `${SWARM_GATEWAY}bytes/${workspace.rfq.specificationRef}`;
    verifiedCopyValues['verified-specification'] = workspace.rfq.specificationRef;
  }
  $('verified-funding-row').hidden = !funded;
  $('verified-deliverable-row').hidden = !delivered;
  $('verified-settlement-row').hidden = !settled;
  $('deliverable-proof').hidden = !delivered;
  if (delivered) {
    const deliverableRef = deliveryRecord.uploadedDeliverable.deliverableRef;
    $('verified-deliverable').textContent = `Reference ${shortAddress(deliverableRef)}`;
    $('deliverable-proof').href = `${SWARM_GATEWAY}bytes/${deliverableRef}`;
    verifiedCopyValues['verified-deliverable'] = deliverableRef;
  }
  const stages = [...$('workspace-lifecycle').children];
  const currentStage = settled ? 5 : delivered ? 4 : funded ? 3 : 2;
  stages.forEach((stage, index) => { stage.className = index < currentStage ? 'complete' : index === currentStage ? 'current' : ''; });
  $('fund-commitment').hidden = funded || Boolean(connectedOther) || connectedSeller;
  $('fund-commitment').disabled = fundingBusy;
  $('submit-delivery').hidden = !(status === 'FUNDED' && connectedSeller);
  $('submit-delivery').disabled = deliveryBusy;
  $('retrieve-deliverable').hidden = !(status === 'DELIVERED' && !retrieved && connectedBuyer);
  $('retrieve-deliverable').disabled = retrievalBusy;
  $('release-commitment').hidden = !(status === 'DELIVERED' && retrieved && connectedBuyer);
  $('release-commitment').disabled = releaseBusy;
  $('deliverable-access').hidden = !retrieved;
  $('open-deliverable').disabled = deliverableAccessBusy;
  $('download-deliverable').disabled = deliverableAccessBusy;
  $('seller-delivery-controls').hidden = !(status === 'FUNDED' && connectedSeller);
  // Demo/operator-only: the handoff link is never rendered in the normal
  // Seller UI (cross-profile MVP plumbing, not a product concept), but stays
  // reachable from the DevTools console for the current cross-profile MVP.
  window.shadowbidDeliveryHandoffLink = (delivered && connectedSeller)
    ? `${location.origin}${location.pathname}#procurement/${workspace.award.awardId}?${buildDeliveryHandoffQuery(deliveryRecord)}`
    : undefined;
  $('settlement-receipt').hidden = !settled;
  if (settled) $('settlement-receipt-amount').textContent = `${workspace.amountLabel} USDC released to Seller`;
  if (settled) {
    message('funding-message', 'Settled on Avalanche Fuji.');
    message('delivery-message', 'Delivery retrieved, accepted and settled.');
    $('delivery-copy').textContent = 'The verified work was accepted and the commitment was released.';
  } else if (retrieved) {
    message('funding-message', connectedBuyer ? 'Approval releases the committed USDC to the Seller.' : 'Connect the Award Buyer to approve and release.');
    message('delivery-message', 'Retrieved from Swarm · exact bytes and deliverable hash verified.');
    $('delivery-copy').textContent = 'The Buyer retrieved and verified the delivered work.';
  } else if (delivered) {
    message('funding-message', connectedBuyer ? 'Retrieve the deliverable before approval.' : 'The deliverable is available for the Award Buyer.');
    message('delivery-message', connectedSeller ? '' : 'Available on Swarm. Approval remains blocked until Buyer retrieval succeeds.');
    $('delivery-copy').textContent = connectedSeller
      ? 'Delivery submitted'
      : 'The Seller delivered the work. Retrieve it before approval.';
  } else if (funded) {
    message('funding-message', connectedSeller ? 'Submit the completed work to the Work Capsule.' : 'Waiting for the Award Seller to submit delivery.');
    message('delivery-message', connectedSeller ? 'Choose the real deliverable file and connect Swarm ID.' : 'Connect the Award Seller to submit delivery.');
    $('delivery-copy').textContent = 'Waiting for the Seller after funding.';
  } else if (connectedOther || connectedSeller) {
    message('funding-message', 'Only the Buyer that owns this Award can fund.', true);
    message('delivery-message', 'Delivery becomes available after funding.');
    $('delivery-copy').textContent = 'Delivery becomes available after funding.';
  } else {
    message('funding-message', connectedBuyer ? 'Ready to fund on Avalanche Fuji.' : 'Connect the Award Buyer when prompted.');
    message('delivery-message', 'Delivery becomes available after funding.');
    $('delivery-copy').textContent = 'Delivery becomes available after funding.';
  }
  if (funded) {
    $('verified-funding').textContent = `Escrow ${shortAddress(workspace.procurementId)} funded`;
    verifiedCopyValues['verified-funding'] = workspace.procurementId;
  }
  const txHash = fundingResult?.fundingTxHash;
  $('funding-proof').hidden = !txHash;
  if (txHash) {
    $('funding-proof').href = fujiTransactionUrl(txHash);
    $('verified-funding').textContent = `Transaction ${shortAddress(txHash)}`;
    verifiedCopyValues['verified-funding'] = txHash;
  }
  const releaseTxHash = releaseResult?.releaseTxHash;
  $('settlement-proof').hidden = !releaseTxHash;
  if (releaseTxHash) {
    $('settlement-proof').href = fujiTransactionUrl(releaseTxHash);
    $('verified-settlement').textContent = `Transaction ${shortAddress(releaseTxHash)}`;
    verifiedCopyValues['verified-settlement'] = releaseTxHash;
  } else if (settled) {
    $('verified-settlement').textContent = `Escrow ${shortAddress(workspace.procurementId)} released`;
    verifiedCopyValues['verified-settlement'] = workspace.procurementId;
  }
}

async function loadWorkspace(awardId, { preserveFunding = false, preserveRelease = false, preserveDelivery = false } = {}) {
  const version = ++workspaceVersion;
  if (!preserveFunding) fundingResult = undefined;
  if (!preserveRelease) releaseResult = undefined;
  if (!preserveFunding && !preserveRelease && !preserveDelivery) {
    $('workspace-status').textContent = 'Loading…';
    delete $('workspace-status').dataset.tone;
  }
  message('funding-message', 'Loading Award and commitment…');
  try {
    const result = await loadProcurementWorkspace({ arkivPublicClient, fujiPublicClient, awardId });
    if (version !== workspaceVersion || route().awardId !== awardId) return;
    if (!result) {
      $('page-title').textContent = 'Procurement unavailable';
      $('page-description').textContent = 'This Award could not be read from Arkiv.';
      $('workspace-view').hidden = true;
      $('unknown-view').hidden = false;
      return;
    }
    workspace = result;
    if (!preserveDelivery) {
      deliveryRecord = loadDeliverySession(localStorage, workspace);
      if (!deliveryRecord) {
        const metadata = parseDeliveryHandoffQuery(route().deliveryLinkQuery, workspace);
        const imported = importDeliveryHandoffLink({ workspace, metadata });
        if (imported) {
          saveDeliverySession(localStorage, imported);
          deliveryRecord = imported;
          message('delivery-message', 'Imported delivery metadata from the handoff link. Retrieve to verify against Swarm.');
        }
      }
    }
    deliveryAttempt = undefined;
    renderWorkspace();
  } catch (error) {
    if (version !== workspaceVersion) return;
    $('workspace-status').textContent = 'Error';
    $('workspace-status').dataset.tone = 'negative';
    message('funding-message', error.message || 'Workspace load failure. Check Arkiv and Fuji, then retry.', true);
  }
}

function scheduleRfqRefresh() {
  if (rfqRefreshScheduled) return;
  rfqRefreshScheduled = true;
  setTimeout(() => {
    rfqRefreshScheduled = false;
    if (route().key === 'rfq') loadRfq(route().rfqId, { preserveExpired: true });
  }, 1200);
}

function renderQuoteCountdowns() {
  if (!rfq) return false;
  let expired = false;
  for (const countdown of document.querySelectorAll('.quote-countdown')) {
    const quote = rfq.quotes.find(candidate => candidate.quoteId === countdown.dataset.quoteId);
    if (!quote) continue;
    const remaining = quote.expiresAtBlock - rfq.snapshotBlock;
    const row = countdown.closest('tr');
    if (remaining <= 0n) {
      countdown.textContent = '00:00';
      if (row) {
        row.classList.add('expired');
        row.dataset.selectable = 'false';
        const status = row.querySelector('.quote-status');
        status.textContent = 'EXPIRED';
        status.dataset.tone = 'negative';
      }
      expiredQuotes.set(quote.quoteId, quote);
      if (selectedQuoteId === quote.quoteId) selectedQuoteId = undefined;
      expired = true;
    } else {
      const soon = remaining <= 30n;
      countdown.textContent = formatRemainingBlocks(remaining);
      countdown.classList.toggle('quote-countdown-soon', soon);
      if (row) {
        const status = row.querySelector('.quote-status');
        status.textContent = soon ? 'EXPIRING SOON' : 'OPEN';
        status.dataset.tone = soon ? 'caution' : 'positive';
      }
    }
  }
  renderExpiredQuotes();
  renderSelection();
  return expired;
}

async function syncRfqClock() {
  if (rfqClockBusy || route().key !== 'rfq' || !rfq) return;
  rfqClockBusy = true;
  try {
    rfq = Object.freeze({ ...rfq, snapshotBlock: await readMarketBlock(arkivPublicClient) });
    if (renderQuoteCountdowns()) scheduleRfqRefresh();
  } catch {
    // The displayed expiry stays tied to the last successful Arkiv block read.
  } finally {
    rfqClockBusy = false;
  }
}

function selectQuote(quoteId) {
  if (!walletSession || walletSession.owner.toLowerCase() !== rfq.buyer.toLowerCase()) return;
  if (awardAttempt) {
    message('award-message', awardConfirmed ? 'An Award has already been created.' : 'Finish confirming the current Award before changing selection.', true);
    return;
  }
  const quote = rfq.quotes.find(candidate => candidate.quoteId === quoteId);
  if (!quote || quoteRemaining(quote) <= 0n) return;
  selectedQuoteId = quoteId;
  awardAttempt = undefined;
  awardConfirmed = false;
  $('award-created').hidden = true;
  renderQuoteRows();
}

$('quote-rows').addEventListener('click', event => {
  const row = event.target.closest('.quote-row');
  if (row) selectQuote(row.dataset.quoteId);
});
$('quote-rows').addEventListener('keydown', event => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  const row = event.target.closest('.quote-row');
  if (row) {
    event.preventDefault();
    selectQuote(row.dataset.quoteId);
  }
});

$('market-filters').addEventListener('submit', event => { event.preventDefault(); loadMarket(); });
$('refresh-market').addEventListener('click', () => loadMarket());
$('load-more').addEventListener('click', () => loadMarket(true));
$('market-show-more').addEventListener('click', () => {
  marketExpanded = !marketExpanded;
  applyMarketDisclosure();
});
window.addEventListener('resize', () => {
  if (route().key === 'market') applyMarketDisclosure();
});

function invalidateWallet() {
  walletSession = undefined;
  $('connect-wallet').textContent = 'Connect wallet';
  $('wallet-display').dataset.walletState = 'disconnected';
  message('wallet-note', 'Wallet changed. Reconnect before publishing.');
  if (route().key === 'rfq' && rfq) refreshSellerAwardedProcurement();
  if (route().key === 'workspace' && workspace && !fundingBusy) renderWorkspace();
}

$('connect-wallet').addEventListener('click', async () => {
  $('connect-wallet').disabled = true;
  try {
    if (provider?.removeListener) {
      provider.removeListener('accountsChanged', invalidateWallet);
      provider.removeListener('chainChanged', invalidateWallet);
      provider.removeListener('disconnect', invalidateWallet);
    }
    provider = window.ethereum;
    walletSession = await connectArkivWallet(provider);
    for (const event of ['accountsChanged', 'chainChanged', 'disconnect']) provider.on?.(event, invalidateWallet);
    $('connect-wallet').textContent = shortAddress(walletSession.owner);
    $('connect-wallet').title = walletSession.owner;
    $('wallet-display').dataset.walletState = 'connected';
    message('wallet-note', 'Wallet connected');
    if (route().key === 'market') loadMarket();
    if (route().key === 'rfq' && rfq) refreshSellerAwardedProcurement();
    if (route().key === 'workspace' && workspace) renderWorkspace();
  } catch {
    invalidateWallet();
    message('wallet-note', 'Wallet unavailable or connection declined. Connect an EVM browser wallet and approve the request network.', true);
  } finally {
    $('connect-wallet').disabled = false;
  }
});

const storage = createWorkStorage(info => {
  const connectionText = info.identity
    ? `Storage · Swarm · ${info.canUpload ? 'Ready' : 'Upload unavailable'}`
    : 'Storage · Swarm · Not connected';
  message('swarm-note', connectionText);
  message('delivery-swarm-note', connectionText);
});

$('connect-swarm').addEventListener('click', async () => {
  $('connect-swarm').disabled = true;
  try { await storage.connect(); }
  catch { message('swarm-note', 'Storage connection unavailable. Retry connecting Swarm ID.', true); }
  finally { $('connect-swarm').disabled = false; }
});

$('connect-delivery-swarm').addEventListener('click', async () => {
  $('connect-delivery-swarm').disabled = true;
  try { await storage.connect(); }
  catch { message('delivery-swarm-note', 'Storage connection unavailable. Retry connecting Swarm ID.', true); }
  finally { $('connect-delivery-swarm').disabled = false; }
});

$('specification-file').addEventListener('change', () => {
  const file = $('specification-file').files[0];
  message('specification-note', file ? `${file.name} · ${file.size} bytes · Ready` : 'Not selected');
});

$('deliverable-file').addEventListener('change', () => {
  const file = $('deliverable-file').files[0];
  message('deliverable-file-note', file ? `${file.name} · ${file.size} bytes · Ready` : 'Not selected');
});

$('request-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (requestBusy || requestCompleted) return;
  requestBusy = true;
  $('publish-request').disabled = true;
  try {
    if (!walletSession) throw new Error('Wallet unavailable. Connect your wallet before publishing.');
    const writer = walletSession;
    await assertWalletSession(provider, writer.owner);
    const swarmClient = requestAttempt?.uploaded ? undefined : storage.client;
    if (!requestAttempt) {
      message('publish-message', 'Preparing Work Capsule');
      const file = $('specification-file').files[0];
      if (!file) throw new Error('Choose a specification file.');
      const bytes = new Uint8Array(await file.arrayBuffer());
      requestAttempt = prepareRequest(Object.fromEntries(new FormData($('request-form'))), bytes, writer.owner);
      $('request-fields').disabled = true;
      $('specification-file').disabled = true;
      $('attempt-note').hidden = false;
    }
    await submitRequestAttempt(requestAttempt, {
      swarmClient,
      buyerArkivWriter: writer,
      arkivPublicClient,
      onStage: stage => message('publish-message', stage),
    });
    requestCompleted = true;
    message('publish-message', 'Request is live. Your Request is now discoverable in the Market.');
    $('publish-request').textContent = 'Request live';
    $('success-market').hidden = false;
    $('attempt-note').hidden = true;
    $('market-filters').reset();
    await loadMarket();
  } catch (error) {
    const prefix = requestAttempt ? (requestAttempt.uploaded ? 'Publication not confirmed. ' : 'Specification not stored. ') : '';
    message('publish-message', prefix + (requestAttempt
      ? 'Retry with this tab open. Uploaded work and the Request ID are reused when available.'
      : error.message), true);
    $('publish-request').textContent = requestAttempt ? 'Retry publication' : 'Publish Request';
  } finally {
    requestBusy = false;
    $('publish-request').disabled = requestCompleted;
  }
});

$('quote-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (quoteBusy) return;
  quoteBusy = true;
  $('publish-quote').disabled = true;
  try {
    if (!walletSession) throw new Error('Connect a Seller wallet.');
    if (walletSession.owner.toLowerCase() === rfq.buyer.toLowerCase()) throw new Error('The RFQ Buyer cannot publish a Seller Quote.');
    await assertWalletSession(provider, walletSession.owner);
    if (!quoteAttempt) quoteAttempt = prepareQuoteAttempt(Object.fromEntries(new FormData($('quote-form'))), rfq, walletSession.owner);
    $('quote-fields').disabled = true;
    message('quote-publish-message', 'Publishing Quote');
    await submitQuoteAttempt(quoteAttempt, { sellerArkivWriter: walletSession, arkivPublicClient });
    message('quote-publish-message', 'Quote submitted. Confirming live Arkiv discovery…');
    await loadRfq(rfq.rfqId, { preserveExpired: true });
    if (!rfq.quotes.some(quote => quote.quoteId === quoteAttempt.quoteId)) {
      throw new Error('Quote submitted; it is not visible in eligible discovery yet. Retry confirmation.');
    }
    quoteAttempt = undefined;
    $('quote-form').reset();
    $('quote-fields').disabled = false;
    $('publish-quote').textContent = 'Publish Quote';
    message('quote-publish-message', 'Quote is live');
  } catch (error) {
    message('quote-publish-message', error.message, true);
    $('publish-quote').textContent = quoteAttempt?.result ? 'Retry confirmation' : 'Retry Quote';
  } finally {
    quoteBusy = false;
    $('publish-quote').disabled = false;
  }
});

$('create-award').addEventListener('click', async () => {
  if (awardBusy) return;
  awardBusy = true;
  $('create-award').disabled = true;
  try {
    if (!walletSession || walletSession.owner.toLowerCase() !== rfq.buyer.toLowerCase()) throw new Error('Connect the RFQ Buyer.');
    await assertWalletSession(provider, walletSession.owner);
    const quote = rfq.quotes.find(candidate => candidate.quoteId === selectedQuoteId);
    if (!quote || quoteRemaining(quote) <= 0n) throw new Error('The selected Quote is no longer active.');
    if (!awardAttempt) awardAttempt = prepareAwardAttempt(rfq, quote);
    message('award-message', 'Revalidating eligible Quote and creating Award…');
    const award = await submitAwardAttempt(awardAttempt, { buyerArkivWriter: walletSession, arkivPublicClient });
    awardConfirmed = true;
    $('award-created').hidden = false;
    $('award-reference').textContent = `Award ${award.awardId} · Procurement ${award.procurementId}`;
    $('open-workspace').href = `#procurement/${award.awardId}`;
    message('award-message', 'Award created from the selected Quote.');
    $('create-award').textContent = 'Award created';
  } catch (error) {
    message('award-message', error.code === 'QUOTE_NO_LONGER_ELIGIBLE'
      ? 'The selected Quote expired naturally and is no longer eligible.'
      : error.message, true);
    if (error.code === 'QUOTE_NO_LONGER_ELIGIBLE') {
      selectedQuoteId = undefined;
      awardAttempt = undefined;
      await loadRfq(rfq.rfqId, { preserveExpired: true });
    }
  } finally {
    awardBusy = false;
    renderSelection();
  }
});

$('fund-commitment').addEventListener('click', async () => {
  if (fundingBusy || !workspace || workspace.status !== 'AWARDED') return;
  fundingBusy = true;
  $('fund-commitment').disabled = true;
  try {
    provider = window.ethereum;
    message('funding-message', 'Preparing transaction');
    const fujiSession = await connectFujiBuyerWallet(provider, workspace.award.buyer);
    const result = await fundProcurement({
      workspace,
      fujiPublicClient,
      fujiWalletClient: fujiSession.walletClient,
      onStage: stage => message('funding-message', stage),
    });
    fundingResult = result;
    await loadWorkspace(workspace.award.awardId, { preserveFunding: true });
    if (workspace.status !== 'FUNDED') throw new Error('Fuji funding completed but FUNDED readback is not confirmed.');
  } catch (error) {
    message('funding-message', error.message || 'The commitment has not been funded on Avalanche Fuji.', true);
  } finally {
    fundingBusy = false;
    if (workspace && route().key === 'workspace') renderWorkspace();
  }
});

document.querySelectorAll('.proof-copy').forEach(button => {
  button.addEventListener('click', async () => {
    const value = verifiedCopyValues[button.dataset.copyRef];
    if (!value) return;
    const original = button.textContent;
    try {
      await navigator.clipboard.writeText(value);
      button.textContent = 'Copied';
    } catch {
      button.textContent = 'Copy failed';
    }
    setTimeout(() => { button.textContent = original; }, 1500);
  });
});

async function accessDeliverable(mode) {
  if (deliverableAccessBusy || !workspace || deliveryRecord?.retrievedByBuyer !== true) return;
  deliverableAccessBusy = true;
  $('open-deliverable').disabled = true;
  $('download-deliverable').disabled = true;
  try {
    message('delivery-message', 'Fetching from Swarm and re-verifying hash…');
    const file = await fetchDeliverableForDownload({ delivery: deliveryRecord, swarmClient: publicWorkReader });
    if (deliverableBlobUrl) URL.revokeObjectURL(deliverableBlobUrl);
    deliverableBlobUrl = URL.createObjectURL(new Blob([file.bytes], { type: file.mediaType }));
    if (mode === 'open') {
      window.open(deliverableBlobUrl, '_blank', 'noopener');
    } else {
      const link = document.createElement('a');
      link.href = deliverableBlobUrl;
      link.download = file.fileName;
      link.click();
    }
    message('delivery-message', `Deliverable ${mode === 'open' ? 'opened' : 'downloaded'} · hash re-verified against Swarm.`);
  } catch (error) {
    message('delivery-message', error.message || 'Could not open/download the deliverable.', true);
  } finally {
    deliverableAccessBusy = false;
    $('open-deliverable').disabled = false;
    $('download-deliverable').disabled = false;
  }
}

$('open-deliverable').addEventListener('click', () => accessDeliverable('open'));
$('download-deliverable').addEventListener('click', () => accessDeliverable('download'));

$('submit-delivery').addEventListener('click', async () => {
  if (deliveryBusy || !workspace || workspaceStatusWithDelivery(workspace, deliveryRecord) !== 'FUNDED') return;
  deliveryBusy = true;
  $('submit-delivery').disabled = true;
  try {
    if (!walletSession || walletSession.owner.toLowerCase() !== workspace.award.seller.toLowerCase()) throw new Error('Connect the Award Seller.');
    await assertWalletSession(provider, walletSession.owner);
    if (!deliveryAttempt) {
      message('delivery-message', 'Preparing file');
      const file = $('deliverable-file').files[0];
      if (!file) throw new Error('Choose a deliverable file.');
      deliveryAttempt = prepareDelivery({
        awardId: workspace.award.awardId,
        seller: walletSession.owner,
        fileName: file.name,
        mediaType: file.type,
        bytes: new Uint8Array(await file.arrayBuffer()),
      });
      $('deliverable-file').disabled = true;
    }
    deliveryRecord = await submitDeliveryAttempt(deliveryAttempt, {
      workspace,
      swarmClient: storage.client,
      onStage: stage => message('delivery-message', stage),
    });
    try { saveDeliverySession(localStorage, deliveryRecord); }
    catch { message('delivery-message', 'Available for this tab. Browser storage is full; free up space before switching to the Buyer.', true); }
    renderWorkspace();
  } catch (error) {
    message('delivery-message', error.message || 'Delivery upload failed. Retry with this tab open.', true);
  } finally {
    deliveryBusy = false;
    $('submit-delivery').disabled = false;
  }
});

$('retrieve-deliverable').addEventListener('click', async () => {
  if (retrievalBusy || !workspace || !deliveryRecord || deliveryRecord.retrievedByBuyer) return;
  retrievalBusy = true;
  $('retrieve-deliverable').disabled = true;
  try {
    if (!walletSession || walletSession.owner.toLowerCase() !== workspace.award.buyer.toLowerCase()) throw new Error('Connect the Award Buyer.');
    await assertWalletSession(provider, walletSession.owner);
    deliveryRecord = await retrieveProcurementDeliverable({
      workspace,
      delivery: deliveryRecord,
      swarmClient: publicWorkReader,
      buyer: walletSession.owner,
      onStage: stage => message('delivery-message', stage),
    });
    saveDeliverySession(localStorage, deliveryRecord);
    renderWorkspace();
  } catch (error) {
    message('delivery-message', `${error.message || 'Deliverable retrieval failed.'} Release remains blocked; retry retrieval.`, true);
  } finally {
    retrievalBusy = false;
    $('retrieve-deliverable').disabled = false;
  }
});

$('release-commitment').addEventListener('click', async () => {
  if (releaseBusy || !workspace || deliveryRecord?.retrievedByBuyer !== true) return;
  releaseBusy = true;
  $('release-commitment').disabled = true;
  try {
    provider = window.ethereum;
    const fujiSession = await connectFujiBuyerWallet(provider, workspace.award.buyer);
    releaseResult = await releaseProcurement({
      workspace,
      delivery: deliveryRecord,
      fujiPublicClient,
      fujiWalletClient: fujiSession.walletClient,
      onStage: stage => message('funding-message', stage),
    });
    await loadWorkspace(workspace.award.awardId, { preserveFunding: true, preserveRelease: true, preserveDelivery: true });
    if (workspace.status !== 'SETTLED') throw new Error('Fuji release completed but SETTLED readback is not confirmed.');
  } catch (error) {
    message('funding-message', error.message || 'The commitment has not been released on Avalanche Fuji.', true);
  } finally {
    releaseBusy = false;
    $('release-commitment').disabled = false;
  }
});

window.addEventListener('beforeunload', event => {
  if (requestBusy || quoteBusy || awardBusy || fundingBusy || deliveryBusy || retrievalBusy || releaseBusy || (requestAttempt && !requestCompleted) || quoteAttempt || (awardAttempt && !awardConfirmed)) {
    event.preventDefault();
    event.returnValue = '';
  }
});
document.querySelector('.skip-link').addEventListener('click', event => {
  event.preventDefault();
  $('main').focus();
});
window.addEventListener('hashchange', () => renderPage({ focus: true }));
setInterval(() => {
  syncMarketClock();
  syncRfqClock();
}, ARKIV_BLOCK_TIME_SECONDS * 1000);
renderPage();
