import { SwarmIdClient } from "@snaha/swarm-id";

import {
  buildFinalWorkCapsuleV1,
  retrieveAndVerifyDeliverable,
  uploadDeliverable,
} from "./deliverable.js";
import {
  SYNTHETIC_SPECIFICATION,
  retrieveAndVerifySpecification,
  uploadSpecification,
} from "./specification.js";

const SYNTHETIC_DELIVERABLE = Uint8Array.of(
  0x53, 0x68, 0x61, 0x64, 0x6f, 0x77, 0x42, 0x69, 0x64,
  0x2d, 0x33, 0x43, 0x00, 0xde, 0xad, 0xbe, 0xef,
);
const MARKET = Object.freeze({
  rfqId: `0x${"11".repeat(32)}`,
  quoteId: `0x${"22".repeat(32)}`,
  awardId: `0x${"33".repeat(32)}`,
  buyer: "0x490b01048Af9878434727daF2C3291D2ff8a67B0",
  seller: "0x4A643d1340F779e5A58a5413eD8908F7e8DC519E",
});

const identityElement = document.querySelector("#identity");
const canUploadElement = document.querySelector("#can-upload");
const byteLengthElement = document.querySelector("#byte-length");
const specificationHashElement = document.querySelector("#specification-hash");
const referenceElement = document.querySelector("#reference");
const retrievalElement = document.querySelector("#retrieval-result");
const byteEqualityElement = document.querySelector("#byte-equality");
const retrievedHashElement = document.querySelector("#retrieved-hash");
const hashEqualityElement = document.querySelector("#hash-equality");
const deliverableByteLengthElement = document.querySelector("#deliverable-byte-length");
const deliverableHashElement = document.querySelector("#deliverable-hash");
const deliverableReferenceElement = document.querySelector("#deliverable-reference");
const deliverableRetrievalElement = document.querySelector("#deliverable-retrieval");
const deliverableByteEqualityElement = document.querySelector("#deliverable-byte-equality");
const deliverableRetrievedHashElement = document.querySelector(
  "#deliverable-retrieved-hash",
);
const deliverableHashEqualityElement = document.querySelector(
  "#deliverable-hash-equality",
);
const capsuleElement = document.querySelector("#work-capsule");
const statusElement = document.querySelector("#status");
const connectButton = document.querySelector("#connect");
const uploadButton = document.querySelector("#upload");
let flowStatus;

function setFlowStatus(status) {
  flowStatus = status;
  statusElement.textContent = status;
}

function renderConnection(info) {
  const identity = info.identity;
  identityElement.textContent = identity
    ? `${identity.name} (${identity.address})`
    : "Not connected";
  canUploadElement.textContent = String(info.canUpload);
  connectButton.disabled = Boolean(identity);
  uploadButton.disabled = !identity || !info.canUpload;

  if (flowStatus) return;
  if (!identity) statusElement.textContent = "NOT CONNECTED";
  else if (!info.canUpload) statusElement.textContent = "CONNECTED — UPLOAD UNAVAILABLE";
  else statusElement.textContent = "READY";
}

const client = new SwarmIdClient({
  iframeOrigin: "https://swarm-id.snaha.net",
  containerId: "swarm-id-container",
  metadata: {
    name: "ShadowBid Specification",
    description: "Canonical specification upload and verification",
  },
  onConnectionChange: renderConnection,
});

connectButton.addEventListener("click", async () => {
  try {
    await client.connect();
  } catch {
    setFlowStatus("CONNECT FAIL");
  }
});

uploadButton.addEventListener("click", async () => {
  uploadButton.disabled = true;
  referenceElement.textContent = "Uploading…";
  retrievalElement.textContent = "Pending";
  byteEqualityElement.textContent = "—";
  retrievedHashElement.textContent = "—";
  hashEqualityElement.textContent = "—";
  setFlowStatus("RUNNING");

  try {
    const uploaded = await uploadSpecification(client, SYNTHETIC_SPECIFICATION);
    byteLengthElement.textContent = String(uploaded.specificationBytes.byteLength);
    specificationHashElement.textContent = uploaded.specificationHash;
    referenceElement.textContent = uploaded.specificationRef;

    const verified = await retrieveAndVerifySpecification(client, uploaded);
    retrievalElement.textContent = "Retrieved from Swarm";
    byteEqualityElement.textContent = verified.byteEquality ? "true" : "false";
    retrievedHashElement.textContent = verified.retrievedHash;
    hashEqualityElement.textContent = verified.hashEquality ? "true" : "false";

    if (!verified.byteEquality || !verified.hashEquality) {
      throw new Error("Specification verification failed");
    }

    const uploadedDeliverable = await uploadDeliverable(
      client,
      SYNTHETIC_DELIVERABLE,
    );
    deliverableByteLengthElement.textContent = String(
      uploadedDeliverable.deliverableBytes.byteLength,
    );
    deliverableHashElement.textContent = uploadedDeliverable.deliverableHash;
    deliverableReferenceElement.textContent = uploadedDeliverable.deliverableRef;

    const verifiedDeliverable = await retrieveAndVerifyDeliverable(
      client,
      uploadedDeliverable,
    );
    deliverableRetrievalElement.textContent = "Retrieved from Swarm";
    deliverableByteEqualityElement.textContent = verifiedDeliverable.byteEquality
      ? "true"
      : "false";
    deliverableRetrievedHashElement.textContent = verifiedDeliverable.retrievedHash;
    deliverableHashEqualityElement.textContent = verifiedDeliverable.hashEquality
      ? "true"
      : "false";

    if (!verifiedDeliverable.byteEquality || !verifiedDeliverable.hashEquality) {
      throw new Error("Deliverable verification failed");
    }

    const capsule = buildFinalWorkCapsuleV1({
      ...MARKET,
      uploadedSpecification: uploaded,
      uploadedDeliverable,
    });
    capsuleElement.textContent = JSON.stringify(capsule, null, 2);
    setFlowStatus("PASS");
  } catch {
    retrievalElement.textContent = "Retrieval unavailable";
    byteEqualityElement.textContent = "false";
    hashEqualityElement.textContent = "false";
    deliverableRetrievalElement.textContent = "Unavailable";
    deliverableByteEqualityElement.textContent = "false";
    deliverableHashEqualityElement.textContent = "false";
    setFlowStatus("FAIL");
  } finally {
    renderConnection(client.connectionInfo);
  }
});

try {
  await client.initialize();
  connectButton.disabled = false;
  renderConnection(client.connectionInfo);
} catch {
  identityElement.textContent = "Initialization failed";
  setFlowStatus("FAIL");
}
