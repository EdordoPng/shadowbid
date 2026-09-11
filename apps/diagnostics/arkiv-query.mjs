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

const smokeGroup = `${Date.now()}_${randomUUID().replaceAll("-", "")}`;
const transport = http(tiramisu.rpcUrls.default.http[0]);
const publicClient = createPublicClient({ chain: tiramisu, transport });
const walletClient = createWalletClient({ account, chain: tiramisu, transport });

let createdEntityKey;
let resultCount = 0;
let expectedEntityFound = false;

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
      service_type: str("query_smoke"),
    },
    payload: jsonToPayload({ purpose: "shadowbid-arkiv-compound-query-smoke" }),
    contentType: "application/json",
    expires: ExpirationTime.fromDays(1),
  });

  createdEntityKey = created.entityKey;
  const receipt = await publicClient.waitForTransactionReceipt({ hash: created.txHash });
  if (receipt.status !== "success") {
    throw new Error("Arkiv create transaction reverted");
  }

  const predicate = and(
    eq("entity_type", str("diagnostic")),
    eq("smoke_group", str(smokeGroup)),
    eq("status", str("open")),
    eq("service_type", str("query_smoke")),
  );

  for (let attempt = 1; attempt <= 10; attempt += 1) {
    const page = await publicClient
      .select({ key: true, attributes: true })
      .where(predicate)
      .limit(100)
      .fetch();

    resultCount = page.entities.length;
    expectedEntityFound = page.entities.some(
      (entity) =>
        entity.key.toLowerCase() === createdEntityKey.toLowerCase() &&
        entity.attributes.entity_type?.value === "diagnostic" &&
        entity.attributes.smoke_group?.value === smokeGroup &&
        entity.attributes.status?.value === "open" &&
        entity.attributes.service_type?.value === "query_smoke",
    );

    if (expectedEntityFound) break;
    if (attempt < 10) await delay(2_000);
  }
} catch {
  expectedEntityFound = false;
}

const passed = Boolean(createdEntityKey && resultCount >= 1 && expectedEntityFound);

console.log("[ARKIV COMPOUND QUERY SMOKE]");
console.log(`network: ${tiramisu.name}`);
console.log(`smokeGroup: ${smokeGroup}`);
console.log(`createdEntityKey: ${createdEntityKey ?? "unavailable"}`);
console.log("conditions: 4");
console.log(`resultCount: ${resultCount}`);
console.log(`expectedEntityFound: ${expectedEntityFound ? "PASS" : "FAIL"}`);
console.log(`status: ${passed ? "PASS" : "FAIL"}`);

if (!passed) process.exitCode = 1;
