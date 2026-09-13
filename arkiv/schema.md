# ShadowBid Arkiv Schema

## Purpose

ShadowBid uses Arkiv as the public, queryable, time-scoped market layer for procurement.

Arkiv stores and exposes:
- RFQs
- Quotes
- Awards
- typed market attributes
- native entity expiry
- queryable market and procurement metadata

Detailed work bytes do **not** live in Arkiv. Specifications and deliverables live on Swarm.

---

## Network baseline

- **Network:** Tiramisu
- **Network ID:** 7738577
- **SDK:** `@arkiv-network/sdk@0.8.0`

ShadowBid uses lowercase / snake_case custom attribute names and explicit typed attributes.

---

# Entity model

## 1. RFQ

**Owner:** Buyer

**Purpose:** Public request for quotation created by the Buyer.

### Attributes

| Field | Type | Purpose |
|---|---|---|
| `entity_type` | `str` | Entity discriminator. Value: `rfq` |
| `rfq_id` | `bytes32` | Application-level RFQ identifier |
| `buyer` | `addr` | Buyer wallet address |
| `service_type` | `str` | Service category, currently `security_review` |
| `max_budget` | `u256` | Maximum accepted price in base units |
| `max_eta_minutes` | `u64` | Maximum accepted delivery ETA |
| `settlement_asset` | `str` | Settlement currency, currently `usdc` |
| `status` | `str` | RFQ lifecycle state, currently `open` |
| `created_at` | `u64` | Record metadata; not currently used by sponsor-critical queries |

### Payload

JSON payload may contain:

```json
{
  "title": "Audit this Solidity contract",
  "shortDescription": "...",
  "requiredDelivery": [
    "...",
    "..."
  ],
  "specificationRef": "...",
  "specificationHash": "0x..."
}
```

### Expiry

Buyer-selected lifetime:

- 15 minutes
- 30 minutes
- 60 minutes
- 120 minutes

The RFQ is intentionally ephemeral market state.

---

## 2. Quote

**Owner:** Seller

**Purpose:** Time-bound commercial offer submitted against an RFQ.

### Attributes

| Field | Type | Purpose |
|---|---|---|
| `entity_type` | `str` | Entity discriminator. Value: `quote` |
| `quote_id` | `bytes32` | Application-level Quote identifier |
| `rfq_id` | `bytes32` | RFQ relationship |
| `seller` | `addr` | Seller wallet address |
| `service_type` | `str` | Service category |
| `price` | `u256` | Quote price in base units |
| `eta_minutes` | `u64` | Proposed delivery ETA |
| `settlement_asset` | `str` | Settlement currency, currently `usdc` |
| `status` | `str` | Quote state, currently `open` |
| `created_at` | `u64` | Record metadata; not currently used by sponsor-critical queries |

### Payload

None in the current MVP.

Quote entities currently use an empty binary payload.

### Expiry

Seller-selected lifetime:

- 1 minute
- 5 minutes
- 15 minutes
- 30 minutes
- 60 minutes

Quote expiry is a core product feature.

Expired Quotes are **not deleted** and are **not updated to `expired` by a cleanup process**. When the Arkiv lifetime ends, they naturally leave the query surface.

---

## 3. Award

**Owner:** Buyer

**Purpose:** Separate Buyer-owned entity that freezes the selected commercial terms.

The Buyer never mutates the Seller-owned Quote into an Award.

### Attributes

| Field | Type | Purpose |
|---|---|---|
| `entity_type` | `str` | Entity discriminator. Value: `award` |
| `award_id` | `bytes32` | Application-level Award identifier |
| `rfq_id` | `bytes32` | Original RFQ relationship |
| `quote_id` | `bytes32` | Selected Quote relationship |
| `buyer` | `addr` | Buyer wallet address |
| `seller` | `addr` | Selected Seller wallet address |
| `amount` | `u256` | Awarded amount in base units |
| `settlement_asset` | `str` | Settlement currency |
| `status` | `str` | Current Arkiv Award status, initially `pending_funding` |
| `deadline` | `u64` | Absolute Unix delivery deadline |
| `created_at` | `u64` | Record metadata; not currently used by sponsor-critical queries |

### Payload

None in the current MVP.

### Expiry

Current Award lifetime:

- 1 day

Award is longer-lived than RFQ/Quote market state and is used as the selected procurement record inside Arkiv.

---

# Attribute vs payload policy

ShadowBid follows this rule:

> Attributes represent market facts needed for discovery, filtering, identity relationships, or lifecycle queries. Payload contains display metadata and opaque references retrieved after an entity has already been identified.

Examples:

### Attributes

`price`

Used because the Buyer queries:

```text
price <= max_budget
```

`eta_minutes`

Used because the Buyer queries:

```text
eta_minutes <= max_eta_minutes
```

`settlement_asset`

Used because ShadowBid filters Quotes and RFQs by settlement currency:

```text
settlement_asset = usdc
```

### Payload

`title`

Displayed to the user but not used to qualify a Quote.

`specificationRef`

Retrieved after the RFQ has already been identified.

`specificationHash`

Used to reconstruct and verify the cross-layer commitment, not for market discovery.

---

# Ownership model

ShadowBid uses wallet ownership deliberately:

```text
RFQ   → Buyer-owned
Quote → Seller-owned
Award → Buyer-owned
```

The Buyer never mutates a Seller-owned Quote.

Selection instead creates a new Buyer-owned Award that references the winning Quote.

Some identity attributes duplicate information already available through Arkiv entity ownership.

They are retained in the ETHRome MVP because they are already load-bearing for application reconstruction and Seller-side Award discovery.

Moving them to payload would reduce queryability, but would not provide meaningful participant privacy because Arkiv ownership and downstream Avalanche settlement remain public.

---

# Canonical queries

## 1. Eligible Quote discovery

This is the sponsor-critical ShadowBid query.

```text
entity_type = quote
AND rfq_id = <current_rfq>
AND service_type = security_review
AND price <= <buyer_budget>
AND eta_minutes <= <buyer_max_eta>
AND settlement_asset = usdc
AND status = open
```

This query is executed through Arkiv.

ShadowBid does **not**:

```text
fetch all Quotes
→ filter in JavaScript
```

Natural Quote expiry directly changes the result of this same query.

---

## 2. RFQ lookup

```text
entity_type = rfq
AND rfq_id = <rfq_id>
```

Used to reconstruct the active request while it remains available.

---

## 3. Quote lookup

```text
entity_type = quote
AND quote_id = <quote_id>
```

Used for Quote identity and validation.

---

## 4. Award lookup

```text
entity_type = award
AND award_id = <award_id>
```

Used to reconstruct procurement state.

---

## 5. Seller Award discovery

```text
entity_type = award
AND rfq_id = <rfq_id>
AND seller = <connected_seller>
```

This lets the winning Seller discover the Award and open the Procurement Workspace.

This is why `seller` remains a queryable Award attribute in the MVP.

---

## 6. Market RFQ discovery

Conceptually:

```text
entity_type = rfq
AND settlement_asset = usdc
AND status = open
```

Optional filters include:

```text
service_type
max_budget
max_eta_minutes
```

---

# Expiry semantics

Expiry is part of ShadowBid's market design, not just data cleanup.

### RFQs

RFQs are intentionally temporary market requests.

### Quotes

Quotes are intentionally temporary offers.

A Quote can be valid at one moment and disappear from the same query later because its Arkiv lifetime ended.

No explicit delete is used.

### Awards

Awards outlive the short-lived market negotiation and represent the selected procurement.

The application does not assume that the original RFQ or Quote will remain queryable forever after Award or funding.

This is important because:

> Arkiv market state is ephemeral, while downstream procurement and economic state may remain valid for longer.

---

# Privacy and data boundaries

ShadowBid does **not** claim private bidding or hidden marketplace participants.

Public Arkiv state includes market metadata needed for discovery and procurement.

Detailed work content does not live in Arkiv.

### Arkiv

Public/queryable market data:

- service
- price
- ETA
- status
- expiry
- application IDs
- Buyer/Seller identity where currently required by the MVP

### Swarm

Actual work bytes:

- detailed specification
- attachments
- proposal body where applicable
- deliverable

### Avalanche

Public economic commitment:

- Buyer
- Seller
- token
- amount
- deadline
- commitment state

The privacy principle is:

> Market terms stay queryable. Detailed work data stays in the Work Capsule.

---

# Current design decisions

For the ETHRome MVP:

```text
buyer attribute
KEEP

seller attribute
KEEP

settlement_asset
KEEP

project_id
NOT USED

created_at
KEEP as metadata, not query-critical

payload encryption
NOT PART OF CORE MVP

actual work bytes
SWARM ONLY
```

No `project_id` field is currently used in the runtime schema.

It may be considered later as optional namespace metadata if useful for shared-network discovery or explorer filtering.

---

# Explorer / query inspection

ShadowBid RFQs are designed to be identifiable on Arkiv query/explorer surfaces through:

```text
entity_type = rfq
```

and can then be inspected through fields such as:

```text
rfq_id
service_type
max_budget
max_eta_minutes
settlement_asset
status
created_at
```

The current MVP does not use a `project_id` attribute. A future additive project namespace could make shared-network filtering more convenient, but it is not required by the application today.

Before using a specific public explorer URL as submission evidence, verify that it is showing the current Tiramisu data surface for these entities.

---

# Summary

ShadowBid uses Arkiv as an actual market layer rather than a generic record store.

The schema is designed around three principles:

1. **Typed queryable market facts** drive real multi-constraint discovery.
2. **Native expiry** changes which offers remain actionable without cleanup transactions.
3. **Ownership is explicit**: Buyer-owned RFQs, Seller-owned Quotes and delivery receipts, Buyer-owned Awards.

Actual work content remains outside Arkiv and is stored on Swarm.

---

## Delivery Receipt entity

`delivery_receipt` is the durable, Seller-owned metadata pointer that lets a
Buyer discover a submitted deliverable without sharing browser storage. It
never contains deliverable bytes and does not represent Buyer retrieval,
verification, acceptance, or Avalanche settlement.

### Queryable attributes

| Attribute | Type | Meaning |
| --- | --- | --- |
| `entity_type` | `str` | Always `delivery_receipt` |
| `award_id` | `bytes32` | Award whose deliverable was submitted |
| `seller` | `addr` | Must equal both the entity owner and Award Seller |
| `created_at` | `u64` | Seller publication time as Unix seconds |

### JSON payload

```json
{
  "deliverableRef": "<Swarm reference>",
  "deliverableHash": "<canonical bytes32 hash>",
  "fileName": "<metadata only>",
  "mediaType": "<metadata only>"
}
```

Receipts are readonly and live until at least 30 days after both publication
and the Award deadline. Discovery filters by `entity_type`, `award_id`, and
`seller`, also constrains Arkiv ownership to the Award Seller, and validates
the payload before use. If duplicate valid receipts exist, the canonical
receipt is the earliest by Arkiv creation block, then `created_at`, then
lexicographically smallest entity key. Buyer retrieval always performs a
fresh Swarm fetch and hash comparison.
