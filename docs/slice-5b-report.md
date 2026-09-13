# Slice 5B — Market + Create Request

## Scope and status

5A visual foundation retained. Implemented only Market discovery and Create Request. No RFQ Detail, quote, award, funding, workspace, delivery, retrieval or release UI. My Activity remains the pre-existing preview. Historical Slice 1–4 diagnostics and dirty work were not reset.

Implementation, local checks, and live acceptance pass. A fresh browser-signed Request titled `Prova Dodo` completed the real specification → Swarm → Arkiv RFQ path and appeared in Market.

## Real paths

- UI → `application/market.js` → installed Arkiv public client, same Tiramisu chain/RPC used by Slice 4 diagnostics. Query uses typed RFQ/asset predicates, optional service/budget/ETA/status predicates, 50-row native cursor pages. QUOTES uses the shared active-Quote query and walks every native cursor page at the RFQ snapshot block. CLOSES IN uses the entity's native `expiresAt` and Arkiv head block with the SDK's nominal two-second block interval. No mock rows. Refresh rereads current chain data.
- UI → `application/buyer-wallet.js` → installed Arkiv `createWalletClient` + viem `custom(provider)` with an authorized JSON-RPC account → existing `createBuyerArkivWriter`. Account and chain are checked before publication; account/chain/disconnect events invalidate the UI connection. Network add/switch is explicit wallet-mediated connection setup, not a chain selector.
- UI → `application/work-storage.js` → same `SwarmIdClient`, origin and upload-capability API as the frozen smoke flow.
- `application/create-request.js` validates input → existing `uploadSpecification` → existing `publishBuyerRequest` via its stored-spec retry inputs → existing `readBackBuyerRequest`. Request live requires matching actual Buyer/ref/hash readback. Market refresh uses only discovery data, never a synthetic success row.

JSON-RPC signing compatibility was checked against the installed Arkiv source (`sendArkivTransaction` calls `writeContract`) and [official viem wallet documentation](https://viem.sh/docs/clients/wallet). No diagnostics/private-key setup is imported into the browser; no env file is read or modified by this work.

## Minimal adaptations

- New application modules contain SDK/client composition; UI has no raw SDK integration.
- Current protocol service remains `security_review` / Security Review. Other services were not invented.
- `publishBuyerRequest` forwards optional `shortDescription` and `requiredDelivery`; the existing RFQ builder validates and includes them only in the JSON payload. Old callers/payloads are unchanged. No indexed field, entity type, ownership, expiry or hash semantics changed. Existing `readBackBuyerRequest` export and return shape remain unchanged; discovery projects optional public description from the payload.
- Specification supports UTF-8 text files. The frozen canonicalizer accepts strings, not arbitrary binary files. Strict decoding preserves BOM; round-trip equality against the existing canonicalizer is verified before upload. Binary/invalid UTF-8 is rejected. No trimming, newline normalization or hashing implementation is added.
- Direct SDK/viem dependencies declared at their already-installed versions; matching workspace lock metadata updated. Vite configuration/routes and root workspace setup unchanged.

## Recovery and UI limits

- The draft is frozen after the first valid attempt; retries reuse the same rfqId and successful Swarm upload ref/hash. Confirmation retries after successful publication do not republish.
- Pending attempts live in memory. Before-unload warning protects accidental loss; cross-reload recovery is not implemented. Keep the tab open during retries. No sensitive work file is persisted in localStorage or a backend.
- Swarm and EVM are separate real connections; Swarm identity is not represented as an EVM signer. No Buyer/Seller mode. The actual signer owns the RFQ.
- Create Request uses an English public-terms form and a separate Work Capsule rail. Native file-picker text follows the browser locale.
- RFQ rows intentionally do not navigate to RFQ Detail, which is excluded from this slice. Quote counts come from real OPEN Quote entities and native expiry. Countdown values are approximate wall-clock renderings of real remaining Arkiv blocks; reaching the authoritative expiry block triggers a Market reread rather than a local EXPIRED claim.
- Read failures expose a retry action, not an empty fake Market. Native expiry remains authoritative. Unchecking Open only does not resurrect natively expired entities.

## Changed files for 5B

- `apps/web/index.html`
- `apps/web/src/ui/app-shell.js`
- `apps/web/src/ui/theme.css` (view-specific additions)
- `apps/web/src/application/market.js`
- `apps/web/src/application/buyer-wallet.js`
- `apps/web/src/application/work-storage.js`
- `apps/web/src/application/create-request.js`
- `apps/web/src/buyer-request.js` (optional forwarding only)
- `packages/shared/src/arkiv/domain.js` (optional RFQ payload metadata only)
- `apps/web/test/market-create.test.js`
- `apps/web/package.json`
- `package-lock.json`
- `docs/slice-5b-report.md`

## Verification

Commands use the existing Windows Node 24.12.0/npm installation via WSL:

- `npm run check`: workspace syntax checks + Hardhat compilation, PASS.
- `npm test`: 123 PASS (web 55, contracts 23, shared 45).
- `npm run build --workspace web`: PASS, all three HTML entrypoints emitted.
- `git diff --check`: PASS; pre-existing CRLF notices only.
- Live read through `discoverMarketRequests(createMarketClient(), {openOnly:true})`: 10 actual RFQs returned at initial 5B verification. The 5B.1 read returned 11 actual RFQs including `Prova Dodo`, with real active-Quote counts and native expiry block data.
- Chrome production preview: 11 live rows visible with REQUEST, SERVICE, BUDGET, MAX ETA, QUOTES, CLOSES IN and STATUS; `Prova Dodo` displayed its real zero active Quotes and countdown derived from native expiry. The real max-budget filter was verified against all returned budgets. Create route/reload, unavailable-wallet message, responsive widths 1440/1280/1024/768/390/320, no page exceptions, both smoke routes HTTP 200: PASS.
- Screenshots inspected: `/tmp/shadowbid-5b-market.png`, `/tmp/shadowbid-5b-create.png`; mobile artifact `/tmp/shadowbid-5b-mobile.png`.
- Added tests cover exact UTF-8 bytes (BOM, CRLF, multibyte text), invalid UTF-8 rejection, public metadata/legacy compatibility, storage failure, publication retry, readback lag, Buyer mismatch, precision/validation, native query pagination and browser-account composition.

Initial new tests exposed that specification canonicalization accepts text only. Fixed the application adapter with strict UTF-8 round-trip validation; frozen hashing/canonicalization modules remained untouched. The full test rerun passed.

## Live write acceptance

VERIFIED: the fresh Request `Prova Dodo` completed specification → real Swarm path → real Arkiv RFQ → visible in Market. An independent Arkiv read for 5B.1 also found `Prova Dodo` with native `expiresAt` data. No autonomous private-key signing, funded golden procurement or simulated Swarm success was used.

## Regressions and next step

Existing tests continue to cover Buyer/Seller/Award ownership, seven-clause quote query, native expiry forwarding, separate Award, procurementId equality, termsHash/Solidity compatibility, Work Capsule and exact-byte hashing, escrow/release behavior. The shared query module received only the reusable active-Quote-by-RFQ read path for 5B.1. No changes to quote publication, award, fund, delivery, retrieve or release use-cases, contracts, ownership module or smoke page source.

Finish only the fresh 5B live acceptance. Do not start 5C.
