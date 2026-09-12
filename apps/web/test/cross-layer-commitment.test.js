import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveTermsHash,
  procurementIdFromAwardId,
} from "@shadowbid/shared/commitment";
import {
  canonicalizeSpecificationBytes,
  hashWorkBytes,
} from "@shadowbid/shared/work-capsule";

import { SYNTHETIC_SPECIFICATION } from "../src/specification.js";

const REAL_SPECIFICATION_HASH =
  "0xb9ae219a64126660be6d2a3494f5af2ba24d265f7665fd7d9e27d595b2e54f92";
const EXPECTED_TERMS_HASH =
  "0x2bc415f504d8ac027c27034893e6b83dc7989a66a40bc91b2eb1e5175bfab1fb";

const TERMS = Object.freeze({
  rfqId: `0x${"11".repeat(32)}`,
  quoteId: `0x${"22".repeat(32)}`,
  awardId: `0x${"33".repeat(32)}`,
  buyer: "0x490b01048Af9878434727daF2C3291D2ff8a67B0",
  seller: "0x4A643d1340F779e5A58a5413eD8908F7e8DC519E",
  token: "0xEAAD2aaC9cdFE74F45F95C74E87b981561BcEbaC",
  amount: 350_000n,
  deadline: 1_800_003_600n,
});

test("binds the real Swarm specification hash to the existing Slice 2 termsHash", () => {
  const specificationBytes = canonicalizeSpecificationBytes(SYNTHETIC_SPECIFICATION);
  const specificationHash = hashWorkBytes(specificationBytes);
  const input = { ...TERMS, specificationHash };

  assert.equal(specificationHash, REAL_SPECIFICATION_HASH);
  assert.equal(procurementIdFromAwardId(TERMS.awardId), TERMS.awardId);
  assert.equal("specification" in input, false);

  const termsHash = deriveTermsHash(input);
  assert.equal(termsHash, EXPECTED_TERMS_HASH);
  assert.equal(deriveTermsHash({ ...input }), EXPECTED_TERMS_HASH);

  const changedSpecificationHash = hashWorkBytes(
    canonicalizeSpecificationBytes(`${SYNTHETIC_SPECIFICATION}\n`),
  );
  assert.notEqual(changedSpecificationHash, specificationHash);
  assert.notEqual(
    deriveTermsHash({ ...TERMS, specificationHash: changedSpecificationHash }),
    termsHash,
  );
});
