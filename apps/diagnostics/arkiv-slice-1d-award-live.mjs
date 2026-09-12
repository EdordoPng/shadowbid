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
  createSellerArkivWriter,
} from "@shadowbid/shared/arkiv";
import { formatEther, http } from "viem";
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
]);

const ENTITY_LIFETIME = ExpirationTime.fromDays(1);
const AWARD_DEADLINE_SECONDS = 6n * 60n * 60n;
const READ_RETRIES = 12;
const READ_RETRY_DELAY_MS = 2_000;

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

  if (actors.Buyer.address.toLowerCase() === actors["Seller A"].address.toLowerCase()) {
    throw new ScenarioError("configuration failure", "Buyer and Seller A wallets must be distinct");
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

async function assertSuccessfulWrite(publicClient, created, label) {
  assertCondition(created?.entityKey, `${label} did not return an Arkiv entityKey`);
  assertCondition(created?.txHash, `${label} did not return a transaction hash`);

  const receipt = await publicClient.waitForTransactionReceipt({ hash: created.txHash });
  if (receipt.status !== "success") {
    throw new ScenarioError("wallet/funding failure", `${label} transaction reverted`);
  }
}

async function readEntityWithRetry(publicClient, entityKey, label) {
  for (let attempt = 1; attempt <= READ_RETRIES; attempt += 1) {
    try {
      return await publicClient.getEntity(entityKey);
    } catch (error) {
      if (attempt === READ_RETRIES) {
        throw new ScenarioError(
          "Arkiv/network failure",
          `${label} was not readable after ${READ_RETRIES} attempts: ${shortMessage(error)}`,
        );
      }
      await delay(READ_RETRY_DELAY_MS);
    }
  }

  throw new ScenarioError("code failure", `${label} read retry loop ended unexpectedly`);
}

function assertIdentity(entity, { label, entityKey, owner, applicationId, idAttribute }) {
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
}

function assertAwardRelationships(
  awardEntity,
  { rfqId, quoteId, buyer, quoteEntity, deadline },
) {
  const awardAttributes = awardEntity.attributes;
  const quoteAttributes = quoteEntity.attributes;

  assertCondition(awardAttributes.entity_type?.value === "award", "Award entity_type mismatch");
  assertCondition(awardAttributes.rfq_id?.value === rfqId, "Award rfq_id mismatch");
  assertCondition(awardAttributes.quote_id?.value === quoteId, "Award quote_id mismatch");
  assertCondition(sameHex(awardAttributes.buyer?.value, buyer), "Award buyer mismatch");
  assertCondition(
    sameHex(awardAttributes.seller?.value, quoteAttributes.seller?.value),
    "Award seller does not match selected Quote seller",
  );
  assertCondition(
    awardAttributes.amount?.value === quoteAttributes.price?.value,
    "Award amount does not match selected Quote price",
  );
  assertCondition(
    awardAttributes.settlement_asset?.value === quoteAttributes.settlement_asset?.value,
    "Award asset does not match selected Quote asset",
  );
  assertCondition(
    awardAttributes.status?.value === "pending_funding",
    "Award status is not pending_funding",
  );
  assertCondition(awardAttributes.deadline?.value === deadline, "Award deadline mismatch");
  assertCondition(awardEntity.payload.byteLength === 0, "Award payload must be empty");
  assertCondition(!Object.hasOwn(awardAttributes, "terms_hash"), "Award contains terms_hash");
  assertCondition(!Object.hasOwn(awardAttributes, "escrow_tx_hash"), "Award contains escrow_tx_hash");
}

async function run() {
  const actors = loadActors();
  const buyer = actors.Buyer;
  const sellerA = actors["Seller A"];
  const rpcUrl = tiramisu.rpcUrls.default.http[0];
  const publicClient = createPublicClient({ chain: tiramisu, transport: http(rpcUrl) });

  const connectedChainId = await publicClient.getChainId();
  if (connectedChainId !== tiramisu.id) {
    throw new ScenarioError(
      "Arkiv/network failure",
      `Unexpected chain ID ${connectedChainId}; expected ${tiramisu.id}`,
    );
  }

  const actorBalances = await Promise.all(
    [buyer, sellerA].map(({ address }) => publicClient.getBalance({ address })),
  );
  const unfundedActors = ["Buyer", "Seller A"].filter(
    (_label, index) => actorBalances[index] === 0n,
  );
  if (unfundedActors.length > 0) {
    throw new ScenarioError(
      "wallet/funding failure",
      `Unfunded Tiramisu actor wallets: ${unfundedActors.join(", ")}`,
    );
  }

  const buyerWalletClient = createWalletClient({
    account: buyer.account,
    chain: tiramisu,
    transport: http(rpcUrl),
  });
  const sellerWalletClient = createWalletClient({
    account: sellerA.account,
    chain: tiramisu,
    transport: http(rpcUrl),
  });
  const buyerWriter = createBuyerArkivWriter({
    walletClient: buyerWalletClient,
    buyer: buyer.address,
  });
  const sellerWriter = createSellerArkivWriter({
    walletClient: sellerWalletClient,
    seller: sellerA.address,
  });

  const rfqId = newApplicationId();
  const quoteId = newApplicationId();
  const awardId = newApplicationId();
  const createdAt = BigInt(Math.floor(Date.now() / 1_000));

  const rfq = await buyerWriter.createRfq({
    rfqId,
    maxBudget: 500_000n,
    maxEtaMinutes: 30n,
    createdAt,
    title: "ShadowBid Slice 1D Buyer-owned Award",
    expires: ENTITY_LIFETIME,
  });
  await assertSuccessfulWrite(publicClient, rfq, "RFQ");

  const quote = await sellerWriter.createQuote({
    quoteId,
    rfqId,
    price: 350_000n,
    etaMinutes: 20n,
    createdAt,
    expires: ENTITY_LIFETIME,
  });
  await assertSuccessfulWrite(publicClient, quote, "Quote");

  const [rfqEntity, selectedQuoteEntity] = await Promise.all([
    readEntityWithRetry(publicClient, rfq.entityKey, "RFQ"),
    readEntityWithRetry(publicClient, quote.entityKey, "Quote"),
  ]);
  assertIdentity(rfqEntity, {
    label: "RFQ",
    entityKey: rfq.entityKey,
    owner: buyer.address,
    applicationId: rfqId,
    idAttribute: "rfq_id",
  });
  assertIdentity(selectedQuoteEntity, {
    label: "Quote",
    entityKey: quote.entityKey,
    owner: sellerA.address,
    applicationId: quoteId,
    idAttribute: "quote_id",
  });
  assertCondition(
    selectedQuoteEntity.attributes.rfq_id?.value === rfqId,
    "Selected Quote does not reference the RFQ",
  );

  const selectedQuote = Object.freeze({
    rfqId: selectedQuoteEntity.attributes.rfq_id.value,
    quoteId: selectedQuoteEntity.attributes.quote_id.value,
    seller: selectedQuoteEntity.attributes.seller.value,
    price: selectedQuoteEntity.attributes.price.value,
    settlementAsset: selectedQuoteEntity.attributes.settlement_asset.value,
  });
  const quoteUpdatedAtBeforeAward = selectedQuoteEntity.updatedAt;
  const awardDeadline = BigInt(createdAt) + AWARD_DEADLINE_SECONDS;

  const award = await buyerWriter.createAward({
    awardId,
    selectedQuote,
    deadline: awardDeadline,
    createdAt,
    expires: ENTITY_LIFETIME,
  });
  await assertSuccessfulWrite(publicClient, award, "Award");

  const [awardEntity, quoteEntityAfterAward] = await Promise.all([
    readEntityWithRetry(publicClient, award.entityKey, "Award"),
    readEntityWithRetry(publicClient, quote.entityKey, "Quote after Award"),
  ]);
  assertIdentity(awardEntity, {
    label: "Award",
    entityKey: award.entityKey,
    owner: buyer.address,
    applicationId: awardId,
    idAttribute: "award_id",
  });
  assertCondition(
    !sameHex(award.entityKey, quote.entityKey),
    "Award must be a separate Arkiv entity from Quote",
  );
  assertAwardRelationships(awardEntity, {
    rfqId,
    quoteId,
    buyer: buyer.address,
    quoteEntity: quoteEntityAfterAward,
    deadline: awardDeadline,
  });
  assertCondition(
    sameHex(quoteEntityAfterAward.owner, sellerA.address),
    "Quote ownership changed after Award creation",
  );
  assertCondition(
    quoteEntityAfterAward.updatedAt === quoteUpdatedAtBeforeAward,
    "Quote was mutated during Award creation",
  );
  assertCondition(
    quoteEntityAfterAward.attributes.quote_id?.value === quoteId &&
      quoteEntityAfterAward.attributes.rfq_id?.value === rfqId &&
      quoteEntityAfterAward.attributes.price?.value === selectedQuote.price,
    "Quote attributes changed during Award creation",
  );

  console.log("[ARKIV SLICE 1D BUYER-OWNED AWARD LIVE]");
  console.log(`network: ${tiramisu.name}`);
  console.log(`networkId: ${connectedChainId}`);
  console.log(`buyerBalance: ${formatEther(actorBalances[0])}`);
  console.log(`sellerABalance: ${formatEther(actorBalances[1])}`);
  console.log(`rfqId: ${rfqId}`);
  console.log(`rfqEntityKey: ${rfq.entityKey}`);
  console.log(`rfqTxHash: ${rfq.txHash}`);
  console.log(`rfqOwner: ${rfqEntity.owner}`);
  console.log(`quoteId: ${quoteId}`);
  console.log(`quoteEntityKey: ${quote.entityKey}`);
  console.log(`quoteTxHash: ${quote.txHash}`);
  console.log(`quoteOwnerBeforeAward: ${selectedQuoteEntity.owner}`);
  console.log(`quoteOwnerAfterAward: ${quoteEntityAfterAward.owner}`);
  console.log(`awardId: ${awardId}`);
  console.log(`awardEntityKey: ${award.entityKey}`);
  console.log(`awardTxHash: ${award.txHash}`);
  console.log(`awardOwner: ${awardEntity.owner}`);
  console.log(`awardBuyer: ${awardEntity.attributes.buyer.value}`);
  console.log(`awardRfqId: ${awardEntity.attributes.rfq_id.value}`);
  console.log(`awardQuoteId: ${awardEntity.attributes.quote_id.value}`);
  console.log(`awardSeller: ${awardEntity.attributes.seller.value}`);
  console.log(`awardAmount: ${awardEntity.attributes.amount.value}`);
  console.log(`awardSettlementAsset: ${awardEntity.attributes.settlement_asset.value}`);
  console.log(`awardDeadline: ${awardEntity.attributes.deadline.value}`);
  console.log(`awardStatus: ${awardEntity.attributes.status.value}`);
  console.log(`awardPayloadBytes: ${awardEntity.payload.byteLength}`);
  console.log("quoteMutated: NO");
  console.log("awardSeparateEntity: PASS");
  console.log("deleteUsed: NO");
  console.log("status: PASS");
}

try {
  await run();
} catch (error) {
  console.error("[ARKIV SLICE 1D BUYER-OWNED AWARD LIVE]");
  console.error("status: FAIL");
  console.error(`failureType: ${classifyFailure(error)}`);
  console.error(`message: ${shortMessage(error)}`);
  process.exitCode = 1;
}
