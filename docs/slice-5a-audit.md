# ShadowBid — Slice 5A audit and implementation report

## CURRENT STATE

Audit performed before shell implementation, 2026-09-12. Slice 1–4 treated as frozen. The user reports a live happy path and 48/48 invariants PASS; that live proof was not rerun by this task.

- Root: npm workspaces `apps/*`, `packages/*`; ESM JavaScript; Node >=24. Scripts: `check`, `test` delegate to existing workspace scripts.
- Frontend: Vite 8.3.0, vanilla HTML/JavaScript. No React, Next, application router, shared layout, providers, component library, Tailwind, TypeScript, or ESLint configuration. No pre-existing app design system to extend. The two smoke pages have independent inline light-theme CSS.
- Existing routes: `/index.html` (previously a static scaffold), `/swarm-smoke.html`, `/delivery-smoke.html`. Before 5A the production Vite inputs included only the smoke pages.
- `packages/application/use-cases` does not exist. Reusable application operations live in `apps/web/src/*.js`; frozen domain/query/context modules are in `packages/shared/src`.
- No browser Arkiv/Avalanche wallet provider or common connection state. Node diagnostics construct signer clients from private environment configuration. Those entrypoints must not be imported into UI.
- Swarm ID exists only in `swarm-smoke.js` and `delivery-smoke.js`: `SwarmIdClient`, initialization, `connectionInfo`, `onConnectionChange`, `identity`, `canUpload`. This is a Swarm upload identity, not evidence of an active Arkiv/Fuji signing wallet.
- `.env.local` exists and is gitignored; its contents were not read or changed. `.env.example` contains public configuration and public demo addresses, no browser `VITE_*` configuration. The shell imports no env data or diagnostic fixtures.
- No project `AGENTS.md` found. `shadowbid_frontend_design_freeze_handoff_v1.0.md` was not found in the repository/parent search; its location was requested. Implementation follows the explicit UX constraints in the task; full handoff compliance remains unverified. No Stitch reference was supplied or consulted.
- Pre-existing dirty work was found in diagnostics package/scripts and shared Arkiv domain/query/tests. Those files were preserved; they are not part of this slice's changes.

## CHANGES MADE

Safe additive adaptation: retain vanilla Vite, add presentation-only app entry styles and navigation; include the existing index in production build. No stop-condition trigger is needed for this limited shell: it does not require wallet changes, integrations, new application operations, protocol states, or entities.

Market and optional My Activity are explicitly labeled previews. Create Request is a disabled CTA with visible explanation. RFQ Detail, Create Request forms, and Procurement Workspace business views remain deferred. No standalone Quote/Award/Funding/Delivery/Retrieval/Settlement pages were added.

## FILES CHANGED

| File | Change |
| --- | --- |
| `apps/web/index.html` | Semantic AppShell, sidebar, two navigation links, header, wallet-unavailable label, disabled CTA, placeholder panel, footer, skip link and inline favicon; valid UTF-8 replaces malformed scaffold text. |
| `apps/web/src/ui/theme.css` | New scoped-to-entry theme, responsive layout, minimal native HTML/CSS primitives. |
| `apps/web/src/ui/app-shell.js` | Presentation-only hash navigation, active link, title/copy, keyboard focus, unknown-page fallback. |
| `apps/web/vite.config.js` | Add index production input; preserve both smoke inputs. |
| `apps/web/package.json` | Extend existing syntax check to include app-shell.js; no dependency changes. |
| `docs/slice-5a-audit.md` | Audit, real exports, integration gaps, validation and limits. |

## SLICE 4 USE-CASE MAP

“Client/server” describes execution compatibility, not an existing backend. These ESM use-cases are dependency-injected and can run in browser or Node with suitable adapters. No application server/API exists. Shared modules are not server endpoints. No exports were renamed.

| Use-case | File → actual export | Client/server | Wallet/context required |
| --- | --- | --- | --- |
| Publish Request | `apps/web/src/buyer-request.js` → `publishBuyerRequest` | Browser/Node orchestration | `swarmClient`, `buyerArkivWriter`, `arkivPublicClient`; specification or retry ref/hash; returns procurement context. |
| RFQ read | `apps/web/src/buyer-request.js` → `readBackBuyerRequest`; `packages/shared/src/arkiv/query.js` → `queryRfqById` | Browser/Node read | Arkiv public client + rfqId; no signer. RFQ readback includes specification linkage. |
| RFQ discovery | No general Market discovery export exists | Missing application read operation | By-id reads are available; no general RFQ list, pagination or activity read model is supplied. |
| Publish Quote | `apps/web/src/seller-quote.js` → `publishSellerQuote` | Browser/Node orchestration | `sellerArkivWriter`, `arkivPublicClient`, rfqId, quote terms and native `expires`. |
| Eligible Quotes | `apps/web/src/buyer-award.js` → `discoverEligibleQuotes`; `packages/shared/src/arkiv/query.js` → `queryOpenQuotes`, `createOpenQuoteQuery`, `buildOpenQuotePredicate` | Browser/Node read | Arkiv public client, rfqId, budget, maxEtaMinutes. Existing seven-clause compound query; no replacement filtering. |
| Create Award | `apps/web/src/buyer-award.js` → `createBuyerAward` | Browser/Node orchestration | Buyer writer + Arkiv public client, rfqId, selectedQuoteId, deadline, expires; revalidates eligibility; procurementId = awardId. |
| Read procurement (partial) | `apps/web/src/fund-award.js` → `readAwardCommitmentInputs`; `packages/shared/src/arkiv/query.js` → `queryAwardById`; `packages/shared/src/procurement.js` → `createProcurementContext`, `deriveProcurementStatus` | Browser/Node read + pure projection | Arkiv public client, awardId, token; context needs real RFQ/Award, escrow and verified retrieval facts. No aggregated `readProcurement` export. |
| Fund | `apps/web/src/fund-award.js` → `fundAward` | Browser/Node orchestration | Fuji public + Buyer wallet client, escrow/USDC addresses and ABIs, commitment from `readAwardCommitmentInputs`. |
| Deliver | `apps/web/src/deliverable.js` → `uploadDeliverable`; `apps/web/src/delivery.js` → `buildDeliveredContext` | Browser/Node adapter + pure context assembly | Swarm upload-capable client and exact bytes; context assembly also requires real IDs, escrow state and successful verification. Upload alone does not imply DELIVERED. |
| Retrieve/verify | `apps/web/src/deliverable.js` → `retrieveAndVerifyDeliverable`; `apps/web/src/specification.js` → `retrieveAndVerifySpecification` | Browser/Node read | Swarm download client, uploaded ref/hash **and original exact bytes** for byte equality. No EVM signer. |
| Work Capsule | `apps/web/src/deliverable.js` → `buildFinalWorkCapsuleV1`; `packages/shared/src/work-capsule.js` → `createWorkCapsuleV1` | Pure Browser/Node | Actual RFQ/Quote/Award IDs, owners and specification/deliverable ref/hash. |
| Release | `apps/web/src/release-award.js` → `releaseAward` | Browser/Node orchestration | Fuji public + Buyer wallet client, escrow/USDC config, commitment and verified-delivery context; existing verification gate preserved. |

Supporting frozen exports: `createBuyerArkivWriter`, `createSellerArkivWriter` in `packages/shared/src/arkiv/ownership.js` bind declared owners to actual signer addresses. `buildEscrowCommitmentInput`, `deriveTermsHash`, `procurementIdFromAwardId` in `packages/shared/src/commitment.js` remain unchanged. Arkiv builders forward native `expires`; the UI introduces no timer/expiry implementation.

### Integration gaps for later slices — not implemented

1. Browser composition of public clients, actual signing wallets and the existing owner-bound writers; chain/account changes and public network config. Do not reuse diagnostics private-key setup or represent Swarm identity as an EVM connection.
2. General RFQ discovery and My Activity reads are absent. Define the smallest application-layer adaptation before a real Market; do not put SDK queries in view code.
3. A reloadable Procurement Workspace read model is absent. Existing reads/projections are partial; escrow ABI/config/read composition currently lives in diagnostics or injected use-case parameters.
4. RFQ readback does not expose all prospective view data (e.g. title/native expiry metadata); eligible Quote selection returns key/attributes and has a default limit of 100. Resolve display/pagination requirements at the existing read boundary, preserving compound filtering/native expiry.
5. Deliverable reference/hash and original exact-byte verification inputs need a Buyer handoff/recovery strategy. Current Work Capsule carries refs/hashes, not original bytes; existing verification expects bytes too. No transport/persistence solution was invented in 5A.
6. Preserve existing generated IDs and partial-success error data across retries when later wiring forms. Async transaction, account, network, and recovery UX is deferred.

## VISUAL / UX CHANGES

Graphite background `#111418`, panel `#191e24`, ice-blue `#b4dcf4`, restrained borders, local system fonts, compact 224px sidebar at desktop. No gradients, neon, glow, remote font requests, invented stats or golden procurement.

Tokens cover color, spacing, type, radii and width. Native primitives: `.button`/`.button-primary` (disabled/focus/hover), `.status-badge` with presentation tones, `.panel`/header/body, `.empty-state`, `.stack`, `.cluster`, `.mono`, `.reference`, `.numeric` with tabular figures and a strong numeric size. No synthetic numeric data is shown merely to demonstrate typography. `Preview` and `Wallet unavailable` are UI labels, never protocol states.

Hash links `#market` and `#activity` avoid a framework/router migration and preserve smoke URLs. These are preview navigation only; future full route design is deferred. Below 760px sidebar navigation becomes horizontal. Landmarks, active-page semantics, keyboard focus, skip link, wrapping references and visible CTA unavailability are included.

## COMMANDS RUN

- Audit: `rg --files`, targeted source/package/config reads, `find ..` for AGENTS/handoff, `git status --short`, `git check-ignore .env.local`; no private env read.
- `npm run check` — real root/workspace syntax checks and Hardhat compile.
- `npm test` — real root/workspace Node and Hardhat suites.
- `npm run build --workspace web` — real production build (repeated after skip-link correction and inline favicon addition).
- `node --check apps/web/src/ui/app-shell.js` — final presentation syntax check after that correction.
- `git diff --check`, targeted diff review.
- Local `vite preview --host 127.0.0.1 --port 4173 --strictPort`; temporary Playwright/Chrome check, no added package or committed test framework.

Environment: Linux `node` was absent from PATH and normal npm resolved to a Windows launcher that refused WSL. Node Windows v24.12.0 was used via the permitted WSL bridge with `C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js`. Initial Linux-style npm path and initial non-hoisted Vite path failed; corrected to Windows npm path and `../../node_modules/vite/bin/vite.js`. Node v20 in the Linux nvm cache was used only for the final standalone syntax check, not the workspace scripts.

No `typecheck` or `lint` script/config exists. The repository's `check` is a syntax/compile check; it is not claimed as TypeScript checking or ESLint. No new toolchain was introduced.

## TEST RESULTS

- Root `check`: PASS; Hardhat reports no contracts needing compilation.
- Root tests: **113 PASS**, zero failures (web 45, contracts 23, shared 45).
- Production build: PASS, all three HTML entrypoints emitted. Shell JS and CSS are separate from the existing Swarm/integration bundles.
- Final shell syntax and `git diff --check`: PASS (Git emitted pre-existing CRLF normalization notices).
- The user-reported live 48/48 invariant proof is separate from these 113 local tests and was not rerun.

## MANUAL VERIFICATION

PASS on the production preview using installed Chrome headless with the existing Playwright runtime (temporary script in `/tmp/shadowbid-5a-browser.cjs`, no repo dependency changes):

- 1440 × 900: inspected screenshot; 224px sidebar, compact header, aligned content/CTA, graphite palette and clear empty preview.
- 390 × 844: inspected full-page screenshot; horizontal navigation, wrapping header, no horizontal overflow.
- Market/My Activity navigation, current-page marker, reload, browser Back and unknown-hash fallback pass.
- Keyboard Tab → skip link → Enter focuses main without changing the current route; navigation focuses main.
- Create Request remains disabled with visible explanatory text. Wallet display accurately says unavailable; no fake connected address, balance, chain or Buyer/Seller switch.
- Zero page exceptions and zero console errors in the final shell check; no external app requests.
- Both existing smoke URLs return HTTP 200 and retain their connection controls. Their external iframe/upload flow was not exercised.

An initial temporary test assertion expected different whitespace around the navigation icon; it was corrected to assert the active page attribute. A subsequent browser run found a missing favicon 404; an inline SVG favicon fixed it, followed by a successful rebuild and browser recheck. Screenshots inspected: `/tmp/shadowbid-5a-desktop.png`, `/tmp/shadowbid-5a-mobile.png`.

## REGRESSIONS CHECKED

Source scope excludes all Slice 1–4 application modules, contracts, shared modules and smoke HTML/JS. Existing tests cover owner binding, seven-clause compound predicate, native expiry forwarding, distinct Award ownership/identity, procurementId equality, Work Capsule, exact-byte hashing, termsHash compatibility, funding/release and retries. No business-layer imports or network calls in the new shell. No role switch, private env exposure, backend, entity, protocol state or duplicated integration.

## UNVERIFIED ITEMS

Missing design handoff and Stitch reference; real connected wallet display (no shared provider exists); live networks and the historical 48/48 proof; full external Swarm iframe runtime and live upload on smoke pages; future aggregated procurement reload/delivery handoff; other browsers and assistive-technology sessions. General RFQ discovery and all business screens are deliberately outside 5A.

## RISKS

The main risks concern future integration: no common wallet composition, incomplete aggregate reads, missing original-byte recovery/handoff, and native-expiry-aware display data. They do not require touching frozen code for the present isolated shell. Visual conformance to the absent handoff cannot be certified. Existing uncommitted Slice 4 work must remain distinct from this patch.

## RECOMMENDED NEXT STEP

Locate and compare the frozen design handoff, then scope the minimal application read/wallet composition needed before a separately authorized Slice 5B. Stop at 5A; no 5B flow has been started.
