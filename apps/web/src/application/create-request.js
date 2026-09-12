import { ExpirationTime } from '@arkiv-network/sdk';
import { canonicalizeSpecificationBytes } from '@shadowbid/shared/work-capsule';
import { generateRfqId, publishBuyerRequest, readBackBuyerRequest } from '../buyer-request.js';
import { uploadSpecification } from '../specification.js';
import { parseBudget, parseEta, service } from './market.js';

export function prepareRequest(fields, specification, buyer) {
  if (fields.serviceType !== service.value) throw new TypeError('Only Security Review is currently supported.');
  if (!fields.title.trim() || fields.title.length > 200) throw new TypeError('Enter a title of at most 200 characters.');
  if (!fields.shortDescription.trim() || fields.shortDescription.length > 1000) throw new TypeError('Enter a short description of at most 1000 characters.');
  const requiredDelivery = fields.requiredDelivery.split('\n').map(s => s.trim()).filter(Boolean);
  if (!requiredDelivery.length || requiredDelivery.length > 20 || requiredDelivery.some(s => s.length > 500)) throw new TypeError('Enter 1–20 requirements, up to 500 characters each.');
  if (![15, 30, 60, 120].includes(Number(fields.lifetime))) throw new TypeError('Select a request lifetime.');
  if (!(specification instanceof Uint8Array) || specification.byteLength === 0) throw new TypeError('Choose a non-empty specification file.');
  // The frozen specification path accepts UTF-8 text. Decode strictly, retain BOM,
  // and prove byte equality before passing text to that unchanged path.
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(specification); }
  catch { throw new TypeError('Specification must be a UTF-8 text file. Binary files are not supported.'); }
  const canonical = canonicalizeSpecificationBytes(text);
  if (canonical.length !== specification.length || canonical.some((b, i) => b !== specification[i])) throw new TypeError('Specification bytes cannot be preserved.');
  const terms = Object.freeze({
    rfqId: generateRfqId(), title: fields.title, shortDescription: fields.shortDescription,
    requiredDelivery: Object.freeze(requiredDelivery), maxBudget: parseBudget(fields.budget),
    maxEtaMinutes: parseEta(fields.maxEta), expires: ExpirationTime.fromMinutes(Number(fields.lifetime)),
  });
  return { buyer, terms, specification: text, uploaded: undefined, result: undefined };
}
// A single attempt survives retries in memory. Never regenerate IDs or re-upload after storage success.
export async function submitRequestAttempt(attempt, { swarmClient, buyerArkivWriter, arkivPublicClient, onStage = () => {} }) {
  if (buyerArkivWriter.owner.toLowerCase() !== attempt.buyer.toLowerCase()) throw new Error('Reconnect the original Buyer to retry.');
  if (!attempt.uploaded) {
    onStage('Storing specification');
    attempt.uploaded = await uploadSpecification(swarmClient, attempt.specification);
  }
  onStage('Publishing Request');
  if (!attempt.result) {
    attempt.result = await publishBuyerRequest({
      ...attempt.terms, buyerArkivWriter, arkivPublicClient,
      specificationRef: attempt.uploaded.specificationRef,
      specificationHash: attempt.uploaded.specificationHash,
    });
  }
  const rfq = await readBackBuyerRequest({ arkivPublicClient, rfqId: attempt.terms.rfqId });
  if (!rfq) throw new Error('Publication submitted; the Request is not readable yet. Retry confirmation.');
  if (rfq.buyer.toLowerCase() !== attempt.buyer.toLowerCase() || rfq.specificationRef !== attempt.uploaded.specificationRef || rfq.specificationHash !== attempt.uploaded.specificationHash) throw new Error('Request readback does not match the submitted work.');
  onStage('Request live');
  return attempt.result;
}
