# Arkiv ETHRome Feedback

## Overall experience

My overall experience building with Arkiv during ETHRome was very positive.

Once the ETHRome Hub and Arkiv MCP were available, the development workflow became very smooth. The MCP was especially useful for quickly finding the current network details, SDK guidance, query patterns, expiry semantics, and event-specific requirements without having to reconstruct the current state from multiple sources.

The on-site support from the Arkiv team was also very valuable. The team was approachable and helpful throughout the competition, and the workshop was clear, well structured, and directly useful during implementation. The presentation material was easy to understand and practical enough to keep using as a reference during the hackathon.

Setup itself was straightforward:
- adding the Tiramisu network to MetaMask was easy;
- obtaining GLM from the faucet worked without issues;
- once the current event baseline was clear, working with typed attributes, compound queries, and entity expiry was smooth.

## Main friction: pre-event network discoverability

The main friction I experienced happened before the hackathon.

The most visible information I found mainly indicated that the Braga testnet was deprecated, but I had not yet found a clear path pointing me to Tiramisu as the network to use for ETHRome.

This created some uncertainty during pre-event preparation about which network and SDK baseline I should prepare against.

Once the ETHRome Hub and MCP were available, that ambiguity largely disappeared.

### Suggested improvement

A very visible pre-event page or banner stating:

- the current hackathon network;
- the current recommended SDK version;
- whether older testnets or examples should be considered obsolete;

would make preparation easier and reduce the chance of building against stale assumptions.

## Secondary friction: designing around natural expiry

Arkiv's native expiry worked well and became one of the most useful parts of the product.

The main challenge was understanding and designing around the architectural consequence of intentionally ephemeral market state.

In ShadowBid, RFQs (Request for Quotes) and Quotes can naturally disappear from queries after expiry, while a procurement that has already been awarded or funded may still need to remain usable.

This required us to explicitly separate:

- ephemeral market state;
- longer-lived procurement/application state;
- durable economic state.

This was not an Arkiv bug, but it was an important design lesson.

### Suggested improvement

A short guide with examples of how to design longer-lived workflows around expiring entities would be very useful.

For example:

> What should an application persist or reference before an entity expires if later stages of the workflow must remain reconstructible?

## Summary

The most useful improvements for me would be:

1. clearer pre-event discoverability of the current network and SDK baseline;
2. more guidance on architectural patterns for workflows built on naturally expiring entities.

Everything else in the event experience was notably smooth, especially the MCP, faucet, Tiramisu setup, workshop, and support from the Arkiv team.
