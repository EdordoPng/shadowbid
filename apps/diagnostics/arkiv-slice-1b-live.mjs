import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import {
  createPublicClient,
  createWalletClient,
  ExpirationTime,
} from "@arkiv-network/sdk";
import { tiramisu } from "@arkiv-network/sdk/chains";
import {
  createBuyerArkivWriter,
  createOpenQuoteQuery,
  createSellerArkivWriter,
} from "@shadowbid/shared/arkiv";
import { http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const REQUIRED_ACTORS = Object.freeze([
  {
    label: "Buyer",
    addressVariable: "SHADOWBID_BUYER_ADDRESS",
    privateKeyVariable: "SHADOWBID_BUYER_PRIVATE_KEY",
  },
  {
    label: "Seller A",
    addressVariable: "SHADOWBID_SELLER_A_ADDRESS",
    privateKeyVariable: "SHADOWBID_SELLER_A_PRIVATE_KEY",
  },
  {
    label: "Seller B",
    addressVariable: "SHADOWBID_SELLER_B_ADDRESS",
    privateKeyVariable: "SHADOWBID_SELLER_B_PRIVATE_KEY",
  },
]);

const QUERY_RETRIES = 12;
const QUERY_RETRY_DELAY_MS = 2_000;
const ENTITY_LIFETIME = ExpirationTime.fromDays(1);

class ScenarioError extends Error {
  constructor(failureType, message) {
    super(message);
    this.failureType = failureType;
  }
}

function loadActors() {
  const missing = [];
  for (const { addressVariable, privateKeyVariable } of REQUIRED_ACTORS) {
    if (!process.env[addressVariable]) missing.push(addressVariable);
    if (!process.env[privateKeyVariable]) missing.push(privateKeyVariable);
  }

  if (missing.length > 0) {
    throw new ScenarioError(
      "configuration failure",
      `Missing required configuration: ${missing.join(", ")}`,
    );
  }

  const actors = Object.fromEntries(
    REQUIRED_ACTORS.map(({ label, addressVariable, privateKeyVariable }) => {
      const configuredAddress = process.env[addressVariable];
      let account;

      try {
        account = privateKeyToAccount(process.env[privateKeyVariable]);
      } catch {
        throw new ScenarioError(
          "configuration failure",
          `${privateKeyVariable} is not a valid private key`,
        );
      }

      if (account.address.toLowerCase() !== configuredAddress.toLowerCase()) {
        throw new ScenarioError(
          "configuration failure",
          `${privateKeyVariable} does not match ${addressVariable}`,
        );
      }

      return [label, { account, address: account.address }];
    }),
  );

  const uniqueAddresses = new Set(
    Object.values(actors).map(({ address }) => address.toLowerCase()),
  );
  if (uniqueAddresses.size !== REQUIRED_ACTORS.length) {
    throw new ScenarioError("configuration failure", "Buyer and Seller wallets must be distinct");
  }

  return actors;
}

function newApplicationId() {
  return `0x${randomBytes(32).toString("hex")}`;
}

function assertCondition(condition, message) {
  if (!condition) throw new ScenarioError("code failure", message);
}

function sameHex(left, right) {
  return left?.toLowerCase() === right?.toLowerCase();
}

async function assertSuccessfulWrite(publicClient, created, label) {
  assertCondition(created?.entityKey, `${label} did not return an Arkiv entityKey`);
  assertCondition(created?.txHash, `${label} did not return a transaction hash`);

  const receipt = await publicClient.waitForTransactionReceipt({ hash: created.txHash });
  if (receipt.status !== "success") {
    throw new ScenarioError("wallet/funding failure", `${label} transaction reverted`);
  }
}

async function readEntityWithRetry(publicClient, entityKey, label) {
  for (let attempt = 1; attempt <= QUERY_RETRIES; attempt += 1) {
    try {
      return await publicClient.getEntity(entityKey);
    } catch (error) {
      if (attempt === QUERY_RETRIES) {
        throw new ScenarioError(
          "Arkiv/network failure",
          `${label} was not readable after ${QUERY_RETRIES} attempts: ${shortMessage(error)}`,
        );
      }
      await delay(QUERY_RETRY_DELAY_MS);
    }
  }

  throw new ScenarioError("code failure", `${label} read retry loop ended unexpectedly`);
}

function assertEntity(entity, { label, entityKey, owner, applicationId, idAttribute, rfqId }) {
  assertCondition(sameHex(entity.key, entityKey), `${label} entityKey readback mismatch`);
  assertCondition(sameHex(entity.owner, owner), `${label} owner does not match its signer`);
  assertCondition(
    entity.attributes?.[idAttribute]?.value === applicationId,
    `${label} application ID readback mismatch`,
  );
  assertCondition(
    !sameHex(applicationId, entityKey),
    `${label} application ID must remain distinct from its Arkiv entityKey`,
  );

  if (rfqId !== undefined) {
    assertCondition(
      entity.attributes?.rfq_id?.value === rfqId,
      `${label} does not reference the scenario RFQ`,
    );
  }
}

function shortMessage(error) {
  const message = error?.shortMessage ?? error?.message ?? String(error);
  return message.split("\n", 1)[0];
}

function classifyFailure(error) {
  if (error instanceof ScenarioError) return error.failureType;

  const message = shortMessage(error).toLowerCase();
  if (
    message.includes("insufficient funds") ||
    message.includes("exceeds the balance") ||
    message.includes("transaction reverted")
  ) {
    return "wallet/funding failure";
  }
  if (
    message.includes("fetch failed") ||
    message.includes("http request failed") ||
    message.includes("network") ||
    message.includes("timed out") ||
    message.includes("timeout") ||
    message.includes("econn") ||
    message.includes("enotfound") ||
    message.includes("eai_again")
  ) {
    return "Arkiv/network failure";
  }

  return "code failure";
}

async function run() {
  const actors = loadActors();
  const buyer = actors.Buyer;
  const sellerA = actors["Seller A"];
  const sellerB = actors["Seller B"];

  const rpcUrl = tiramisu.rpcUrls.default.http[0];
  const publicClient = createPublicClient({ chain: tiramisu, transport: http(rpcUrl) });
  const buyerWalletClient = createWalletClient({
    account: buyer.account,
    chain: tiramisu,
    transport: http(rpcUrl),
  });
  const sellerAWalletClient = createWalletClient({
    account: sellerA.account,
    chain: tiramisu,
    transport: http(rpcUrl),
  });
  const sellerBWalletClient = createWalletClient({
    account: sellerB.account,
    chain: tiramisu,
    transport: http(rpcUrl),
  });

  const connectedChainId = await publicClient.getChainId();
  if (connectedChainId !== tiramisu.id) {
    throw new ScenarioError(
      "Arkiv/network failure",
      `Unexpected chain ID ${connectedChainId}; expected ${tiramisu.id}`,
    );
  }

  const actorBalances = await Promise.all(
    [buyer, sellerA, sellerB].map(({ address }) => publicClient.getBalance({ address })),
  );
  const unfundedActors = ["Buyer", "Seller A", "Seller B"].filter(
    (_label, index) => actorBalances[index] === 0n,
  );
  if (unfundedActors.length > 0) {
    throw new ScenarioError(
      "wallet/funding failure",
      `Unfunded Tiramisu actor wallets: ${unfundedActors.join(", ")}`,
    );
  }

  const buyerWriter = createBuyerArkivWriter({
    walletClient: buyerWalletClient,
    buyer: buyer.address,
  });
  const sellerAWriter = createSellerArkivWriter({
    walletClient: sellerAWalletClient,
    seller: sellerA.address,
  });
  const sellerBWriter = createSellerArkivWriter({
    walletClient: sellerBWalletClient,
    seller: sellerB.address,
  });

  const rfqId = newApplicationId();
  const quoteAId = newApplicationId();
  const quoteBId = newApplicationId();
  const createdAt = BigInt(Math.floor(Date.now() / 1_000));

  const rfq = await buyerWriter.createRfq({
    rfqId,
    maxBudget: 500_000n,
    maxEtaMinutes: 30n,
    createdAt,
    title: "ShadowBid Slice 1B security review",
    expires: ENTITY_LIFETIME,
  });
  await assertSuccessfulWrite(publicClient, rfq, "RFQ");

  const quoteA = await sellerAWriter.createQuote({
    quoteId: quoteAId,
    rfqId,
    price: 350_000n,
    etaMinutes: 20n,
    createdAt,
    expires: ENTITY_LIFETIME,
  });
  await assertSuccessfulWrite(publicClient, quoteA, "Quote A");

  const quoteB = await sellerBWriter.createQuote({
    quoteId: quoteBId,
    rfqId,
    price: 250_000n,
    etaMinutes: 10n,
    createdAt,
    expires: ENTITY_LIFETIME,
  });
  await assertSuccessfulWrite(publicClient, quoteB, "Quote B");

  const [rfqEntity, quoteAEntity, quoteBEntity] = await Promise.all([
    readEntityWithRetry(publicClient, rfq.entityKey, "RFQ"),
    readEntityWithRetry(publicClient, quoteA.entityKey, "Quote A"),
    readEntityWithRetry(publicClient, quoteB.entityKey, "Quote B"),
  ]);

  assertEntity(rfqEntity, {
    label: "RFQ",
    entityKey: rfq.entityKey,
    owner: buyer.address,
    applicationId: rfqId,
    idAttribute: "rfq_id",
  });
  assertEntity(quoteAEntity, {
    label: "Quote A",
    entityKey: quoteA.entityKey,
    owner: sellerA.address,
    applicationId: quoteAId,
    idAttribute: "quote_id",
    rfqId,
  });
  assertEntity(quoteBEntity, {
    label: "Quote B",
    entityKey: quoteB.entityKey,
    owner: sellerB.address,
    applicationId: quoteBId,
    idAttribute: "quote_id",
    rfqId,
  });

  const query = createOpenQuoteQuery(publicClient, {
    rfqId,
    budget: 500_000n,
    maxEtaMinutes: 30n,
  });
  const expectedQuoteIds = [quoteAId, quoteBId].sort();
  let page;
  let returnedQuoteIds = [];

  for (let attempt = 1; attempt <= QUERY_RETRIES; attempt += 1) {
    page = await query.fetch();
    returnedQuoteIds = page.entities
      .map((entity) => entity.attributes.quote_id?.value)
      .sort();

    if (
      page.entities.length === 2 &&
      returnedQuoteIds.length === 2 &&
      returnedQuoteIds[0] === expectedQuoteIds[0] &&
      returnedQuoteIds[1] === expectedQuoteIds[1]
    ) {
      break;
    }

    if (attempt < QUERY_RETRIES) await delay(QUERY_RETRY_DELAY_MS);
  }

  assertCondition(page !== undefined, "Compound query did not return a page");
  assertCondition(
    page.entities.length === 2,
    `Compound query returned ${page.entities.length} entities; expected exactly 2`,
  );
  assertCondition(
    returnedQuoteIds.length === 2 &&
      returnedQuoteIds[0] === expectedQuoteIds[0] &&
      returnedQuoteIds[1] === expectedQuoteIds[1],
    "Compound query did not return both scenario quote IDs",
  );

  console.log("[ARKIV SLICE 1B LIVE]");
  console.log(`network: ${tiramisu.name}`);
  console.log(`networkId: ${connectedChainId}`);
  console.log(`buyer: ${buyer.address}`);
  console.log(`sellerA: ${sellerA.address}`);
  console.log(`sellerB: ${sellerB.address}`);
  console.log(`rfqId: ${rfqId}`);
  console.log(`rfqEntityKey: ${rfq.entityKey}`);
  console.log(`rfqTxHash: ${rfq.txHash}`);
  console.log(`quoteAId: ${quoteAId}`);
  console.log(`quoteAEntityKey: ${quoteA.entityKey}`);
  console.log(`quoteATxHash: ${quoteA.txHash}`);
  console.log(`quoteBId: ${quoteBId}`);
  console.log(`quoteBEntityKey: ${quoteB.entityKey}`);
  console.log(`quoteBTxHash: ${quoteB.txHash}`);
  console.log(`query: ${query}`);
  console.log(`returnedQuoteIds: ${returnedQuoteIds.join(",")}`);
  console.log(`resultCount: ${page.entities.length}`);
  console.log("filtering: ARKIV");
  console.log("deleteUsed: NO");
  console.log("expiryProofUsed: NO");
  console.log("awardUsed: NO");
  console.log("status: PASS");
}

try {
  await run();
} catch (error) {
  console.error("[ARKIV SLICE 1B LIVE]");
  console.error("status: FAIL");
  console.error(`failureType: ${classifyFailure(error)}`);
  console.error(`message: ${shortMessage(error)}`);
  process.exitCode = 1;
}
