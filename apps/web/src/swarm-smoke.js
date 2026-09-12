import { SwarmIdClient } from "@snaha/swarm-id";

const SMOKE_CONTENT = "ShadowBid Swarm smoke local";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const identityElement = document.querySelector("#identity");
const canUploadElement = document.querySelector("#can-upload");
const referenceElement = document.querySelector("#reference");
const retrievalElement = document.querySelector("#retrieval");
const equalityElement = document.querySelector("#equality");
const statusElement = document.querySelector("#status");
const connectButton = document.querySelector("#connect");
const uploadButton = document.querySelector("#upload");
let smokeStatus;

function setSmokeStatus(status) {
  smokeStatus = status;
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

  if (smokeStatus) return;
  if (!identity) statusElement.textContent = "NOT CONNECTED";
  else if (!info.canUpload) statusElement.textContent = "CONNECTED — UPLOAD UNAVAILABLE";
  else statusElement.textContent = "READY";
}

const client = new SwarmIdClient({
  iframeOrigin: "https://swarm-id.snaha.net",
  containerId: "swarm-id-container",
  metadata: {
    name: "ShadowBid Swarm Smoke",
    description: "Minimal browser-only Swarm upload and retrieval check",
  },
  onConnectionChange: renderConnection,
});

connectButton.addEventListener("click", async () => {
  try {
    await client.connect();
  } catch {
    setSmokeStatus("CONNECT FAIL");
  }
});

uploadButton.addEventListener("click", async () => {
  uploadButton.disabled = true;
  referenceElement.textContent = "Uploading…";
  retrievalElement.textContent = "—";
  equalityElement.textContent = "—";
  setSmokeStatus("RUNNING");

  try {
    const uploaded = await client.uploadData(encoder.encode(SMOKE_CONTENT));
    referenceElement.textContent = uploaded.reference;

    const downloaded = await client.downloadData(uploaded.reference);
    const retrievedContent = decoder.decode(downloaded);
    const matches = retrievedContent === SMOKE_CONTENT;

    retrievalElement.textContent = retrievedContent;
    equalityElement.textContent = matches ? "PASS" : "FAIL";
    setSmokeStatus(matches ? "PASS" : "FAIL");
  } catch {
    retrievalElement.textContent = "Retrieval unavailable";
    equalityElement.textContent = "FAIL";
    setSmokeStatus("FAIL");
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
  setSmokeStatus("FAIL");
}
