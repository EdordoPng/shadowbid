import { SwarmIdClient } from "@snaha/swarm-id";

import { uploadDeliverable } from "./deliverable.js";
import { SYNTHETIC_DELIVERABLE_4E } from "./delivery.js";

const identityElement = document.querySelector("#identity");
const canUploadElement = document.querySelector("#can-upload");
const byteLengthElement = document.querySelector("#byte-length");
const deliverableHashElement = document.querySelector("#deliverable-hash");
const deliverableReferenceElement = document.querySelector("#deliverable-reference");
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
    name: "ShadowBid Deliverable",
    description: "Slice 4E fresh deliverable upload",
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
  deliverableReferenceElement.textContent = "Uploading…";
  setFlowStatus("RUNNING");

  try {
    const uploaded = await uploadDeliverable(client, SYNTHETIC_DELIVERABLE_4E);
    byteLengthElement.textContent = String(uploaded.deliverableBytes.byteLength);
    deliverableHashElement.textContent = uploaded.deliverableHash;
    deliverableReferenceElement.textContent = uploaded.deliverableRef;
    setFlowStatus("PASS");
  } catch {
    deliverableReferenceElement.textContent = "Upload failed";
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
