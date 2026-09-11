import { privateKeyToAccount } from "viem/accounts";

const privateKey = process.env.ARKIV_BUYER_PRIVATE_KEY;

if (!privateKey) {
  console.error("ARKIV_BUYER_PRIVATE_KEY is missing");
  process.exit(1);
}

const expectedAddress = "0x490b01048Af9878434727daF2C3291D2ff8a67B0";
const account = privateKeyToAccount(privateKey);
const matches = account.address.toLowerCase() === expectedAddress.toLowerCase();

console.log("[ARKIV WALLET CHECK]");
console.log(`address: ${account.address}`);
console.log(`expected: ${expectedAddress}`);
console.log(`match: ${matches ? "PASS" : "FAIL"}`);
