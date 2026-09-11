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
import { http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const expectedAddress = "0x490b01048Af9878434727daF2C3291D2ff8a67B0";
const privateKey = process.env.ARKIV_BUYER_PRIVATE_KEY;

if (!privateKey) {
  console.error("ARKIV_BUYER_PRIVATE_KEY is missing");
  process.exit(1);
}

const account = privateKeyToAccount(privateKey);

if (account.address.toLowerCase() !== expectedAddress.toLowerCase()) {
  console.error("ARKIV_BUYER_PRIVATE_KEY address mismatch");
  process.exit(1);
}

const smokeId = `${Date.now()}_${randomUUID().replaceAll("-", "")}`;
const transport = http(tiramisu.rpcUrls.default.http[0]);
const publicClient = createPublicClient({ chain: tiramisu, transport });
const walletClient = createWalletClient({ account, chain: tiramisu, transport });

let txHash;
let entityKey;
let readBack = false;

try {
  const connectedChainId = await publicClient.getChainId();
  if (connectedChainId !== tiramisu.id) {
    throw new Error(`Unexpected chain ID: ${connectedChainId}`);
  }

  const created = await walletClient.createEntity({
    attributes: {
      entity_type: str("diagnostic"),
      smoke_id: str(smokeId),
      status: str("open"),
    },
    payload: jsonToPayload({ purpose: "shadowbid-arkiv-write-smoke" }),
    contentType: "application/json",
    expires: ExpirationTime.fromDays(1),
  });

  txHash = created.txHash;
  entityKey = created.entityKey;

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") {
    throw new Error("Arkiv create transaction reverted");
  }

  let entity;
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    try {
      entity = await publicClient.getEntity(entityKey);
      break;
    } catch {
      if (attempt === 10) throw new Error("Arkiv entity readback timed out");
      await delay(2_000);
    }
  }

  readBack =
    entity.key.toLowerCase() === entityKey.toLowerCase() &&
    entity.attributes.entity_type?.value === "diagnostic" &&
    entity.attributes.smoke_id?.value === smokeId &&
    entity.attributes.status?.value === "open" &&
    entity.toJson()?.purpose === "shadowbid-arkiv-write-smoke";
} catch {
  readBack = false;
}

const passed = Boolean(txHash && entityKey && readBack);

console.log("[ARKIV WRITE SMOKE]");
console.log(`network: ${tiramisu.name}`);
console.log(`chainId: ${tiramisu.id}`);
console.log(`wallet: ${account.address}`);
console.log(`smokeId: ${smokeId}`);
console.log(`txHash: ${txHash ?? "unavailable"}`);
console.log(`entityKey: ${entityKey ?? "unavailable"}`);
console.log(`readBack: ${readBack ? "PASS" : "FAIL"}`);
console.log(`status: ${passed ? "PASS" : "FAIL"}`);

if (!passed) process.exitCode = 1;
