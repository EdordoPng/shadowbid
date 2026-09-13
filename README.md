# ShadowBid

Live quotes. Expiring commitments. User-owned work. Stablecoin settlement.

ShadowBid is a procurement protocol for short-lived digital work.

## Status

ETHRome 2026 hackathon project.

Current phase: end-to-end prototype completed and deployed.

## Architecture

- **Arkiv** — public, queryable and time-scoped market state
- **Avalanche Fuji** — stablecoin-backed commitment and settlement
- **Swarm** — user-owned work data

## Arkiv

ShadowBid uses Arkiv as the live procurement market layer.

Buyers publish **RFQs**, Sellers respond with time-bound **Quotes**, and the Buyer creates a separate **Award** when selecting a winning offer.

Arkiv typed attributes are used for real compound discovery rather than simple lookup-by-id.

For example, ShadowBid queries eligible Quotes using multiple constraints at once:

```text
entity_type = quote
AND rfq_id = <rfq>
AND service_type = security_review
AND price <= <budget>
AND eta_minutes <= <max_eta>
AND settlement_asset = usdc
AND status = open
```

Quote lifetime is also part of the product logic.

When a Quote expires naturally on Arkiv, it disappears from the same query without a delete call, cleanup job, or client-side status mutation. This is used directly by ShadowBid to determine which offers remain actionable.

Ownership is explicit:

- RFQ → Buyer-owned
- Quote → Seller-owned
- Award → Buyer-owned

Arkiv stores market metadata and references, not the actual work files. Detailed specifications and deliverables are kept outside Arkiv.

See [`/arkiv/schema.md`](./arkiv/schema.md) for the full entity and query schema.

## Swarm

ShadowBid uses Swarm for the actual work data exchanged between Buyer and Seller.

The Buyer uploads the procurement specification to Swarm, and the Seller uploads the final deliverable after an Award has been funded.

ShadowBid uses **Swarm ID** for authenticated Buyer and Seller uploads through `@snaha/swarm-id`. Connecting Swarm ID with upload capability is required before either party can publish work data to Swarm.

Retrieval uses the public Swarm gateway instead. Given a Swarm content reference, ShadowBid fetches the bytes directly and verifies their hash locally before allowing the procurement flow to continue.

This lets ShadowBid coordinate the exchange of work without becoming the central custodian of the files. Swarm ID handles the write path, while content-addressed public retrieval and local hash verification keep the read path portable and independently verifiable.

### Where Swarm is used

Main integration points:

- `apps/web/src/application/work-storage.js` — creates and connects the `SwarmIdClient`, and gates uploads on an active upload-capable Swarm ID session
- `apps/web/src/application/swarm-reader.js` — retrieves bytes from the public Swarm gateway
- `apps/web/src/specification.js` — uploads and verifies Buyer specifications
- `apps/web/src/deliverable.js` — uploads and verifies Seller deliverables
- `apps/web/src/application/create-request.js` — orchestrates Buyer specification upload before RFQ publication
- `apps/web/src/application/procurement-delivery.js` — orchestrates Seller delivery upload and Buyer retrieval

### Next

Next, I would add encrypted Work Capsules with selective Buyer/Seller access while keeping the same content-addressed verification flow.

## Avalanche Fuji

ShadowBid uses Avalanche Fuji for the economic commitment and settlement layer.

After a Buyer selects a winning Quote, the procurement terms are committed into `ShadowBidEscrow`. The Buyer approves and locks Fuji test USDC, creating a stablecoin-backed commitment to the selected Seller.

Once the Seller delivers the work and the Buyer verifies it, the Buyer releases the escrowed USDC. If the deadline passes without settlement, the escrow can be refunded to the Buyer.

### Deployment

- **Network:** Avalanche Fuji C-Chain
- **Chain ID:** `43113`
- **Contract:** `ShadowBidEscrow`
- **Escrow address:** `0xB8d8ba69db07B957C4ce97220BF8b88E558D0738`
- **Test USDC:** `0x5425890298aed601595a70AB815c96711a31Bc65`
- **USDC decimals:** `6`

### Stablecoin flow

```text
Approve USDC
→ Fund escrow
→ Seller delivers
→ Buyer verifies delivery
→ Release USDC
```

The escrow lifecycle is:

```text
NONE → FUNDED → RELEASED
             ↘ REFUNDED
```

The contract performs real onchain ERC-20 transfers on Fuji.

A verified historical release transaction:

```text
0x8ed9e2f981f55423584f29638ef90d5f0b6c7dc61800a3d5ca74efd0a0dacbb2
```

For that flow, the Seller USDC balance increased by `350000` base units (`0.35 USDC`).

Main integration points:

- `packages/contracts/contracts/ShadowBidEscrow.sol` — escrow state machine and ERC-20 settlement logic
- `apps/web/src/fund-award.js` — reads commitment inputs, approves USDC when needed, and funds the escrow
- `apps/web/src/release-award.js` — releases escrowed USDC after verified delivery
- `apps/web/src/application/avalanche.js` — Fuji chain configuration and deployed contract address

## Run locally

```bash
npm install
npm run dev --workspace apps/web
```

## Development

Runtime baseline:

- Node.js `24.12.0`
- npm `11.6.2`
- npm workspaces
