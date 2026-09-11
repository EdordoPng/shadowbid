import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import {
  createPublicClient,
  createWalletClient,
  ExpirationTime,
  jsonToPayload,
} from "@arkiv-network/sdk";
import { str } from "@arkiv-network/sdk/attr";
import { tiramisu } from "@arkiv-network/sdk/chains";
import { and, eq } from "@arkiv-network/sdk/query";
import { http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const EXPECTED_ADDRESS = "0x490b01048Af9878434727daF2C3291D2ff8a67B0";
const EXPIRY_BLOCKS = 12;
const WAIT_TIMEOUT_MS = 90_000;
const privateKey = process.env.SHADOWBID_BUYER_PRIVATE_KEY;

if (!privateKey) {
  console.error("SHADOWBID_BUYER_PRIVATE_KEY is missing");
  process.exit(1);
}

const account = privateKeyToAccount(privateKey);

if (account.address.toLowerCase() !== EXPECTED_ADDRESS.toLowerCase()) {
  console.error("SHADOWBID_BUYER_PRIVATE_KEY address mismatch");
  process.exit(1);
}

const smokeGroup = `${Date.now()}_${randomUUID().replaceAll("-", "")}`;
const transport = http(tiramisu.rpcUrls.default.http[0]);
const publicClient = createPublicClient({ chain: tiramisu, transport });
const walletClient = createWalletClient({ account, chain: tiramisu, transport });

const predicate = and(
  eq("entity_type", str("diagnostic")),
  eq("smoke_group", str(smokeGroup)),
  eq("status", str("open")),
  eq("service_type", str("expiry_smoke")),
);

const runCompoundQuery = () =>
  publicClient
    .select({ key: true, attributes: true })
    .where(predicate)
    .limit(100)
    .fetch();

let txHash;
let entityKey;
let appliedExpiresAt;
let beforeBlock;
let beforeResultCount = 0;
let beforePresent = false;
let afterResultCount = 0;
let afterAbsent = false;

try {
  const connectedChainId = await publicClient.getChainId();
  if (connectedChainId !== tiramisu.id) {
    throw new Error(`Unexpected chain ID: ${connectedChainId}`);
  }

  const created = await walletClient.createEntity({
    attributes: {
      entity_type: str("diagnostic"),
      smoke_group: str(smokeGroup),
      status: str("open"),
      service_type: str("expiry_smoke"),
    },
    payload: jsonToPayload({ purpose: "shadowbid-arkiv-expiry-smoke" }),
    contentType: "application/json",
    expires: ExpirationTime.fromBlocks(EXPIRY_BLOCKS),
  });

  txHash = created.txHash;
  entityKey = created.entityKey;
  appliedExpiresAt = created.expiresAt;

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") {
    throw new Error("Arkiv create transaction reverted");
  }

  const beforePage = await runCompoundQuery();
  beforeBlock = beforePage.blockNumber;
  beforeResultCount = beforePage.entities.length;
  beforePresent = beforePage.entities.some(
    (entity) =>
      entity.key.toLowerCase() === entityKey.toLowerCase() &&
      entity.attributes.entity_type?.value === "diagnostic" &&
      entity.attributes.smoke_group?.value === smokeGroup &&
      entity.attributes.status?.value === "open" &&
      entity.attributes.service_type?.value === "expiry_smoke",
  );

  if (!beforePresent) throw new Error("Entity was not present before expiry");

  const waitDeadline = Date.now() + WAIT_TIMEOUT_MS;
  let currentBlock = await publicClient.getBlockNumber();
  while (currentBlock <= appliedExpiresAt) {
    if (Date.now() >= waitDeadline) throw new Error("Expiry block wait timed out");
    await delay(1_000);
    currentBlock = await publicClient.getBlockNumber();
  }

  for (let attempt = 1; attempt <= 10; attempt += 1) {
    const afterPage = await runCompoundQuery();
    afterResultCount = afterPage.entities.length;
    afterAbsent = afterPage.blockNumber > appliedExpiresAt && afterResultCount === 0;

    if (afterAbsent) break;
    if (attempt < 10) await delay(2_000);
  }
} catch {
  afterAbsent = false;
}

const passed = Boolean(
  txHash && entityKey && beforePresent && beforeResultCount >= 1 && afterAbsent,
);
const expiryInfo = `${EXPIRY_BLOCKS} blocks (appliedExpiresAt: ${appliedExpiresAt?.toString() ?? "unavailable"}, beforeQueryBlock: ${beforeBlock?.toString() ?? "unavailable"})`;

console.log("[ARKIV MISSION 02 EXPIRY SMOKE]");
console.log(`network: ${tiramisu.name}`);
console.log(`smokeGroup: ${smokeGroup}`);
console.log(`txHash: ${txHash ?? "unavailable"}`);
console.log(`entityKey: ${entityKey ?? "unavailable"}`);
console.log(`expiry: ${expiryInfo}`);
console.log(`beforeResultCount: ${beforeResultCount}`);
console.log(`beforePresent: ${beforePresent ? "PASS" : "FAIL"}`);
console.log(`afterResultCount: ${afterResultCount}`);
console.log(`afterAbsent: ${afterAbsent ? "PASS" : "FAIL"}`);
console.log("deleteUsed: NO");
console.log(`status: ${passed ? "PASS" : "FAIL"}`);

if (!passed) process.exitCode = 1;
