import { createPublicClient } from "@arkiv-network/sdk";
import { tiramisu } from "@arkiv-network/sdk/chains";
import { http } from "viem";

import { createOpenQuoteQuery } from "@shadowbid/shared/arkiv";

const publicClient = createPublicClient({
  chain: tiramisu,
  transport: http(tiramisu.rpcUrls.default.http[0]),
});

const query = createOpenQuoteQuery(publicClient, {
  rfqId: `0x${"01".repeat(32)}`,
  budget: 500_000n,
  maxEtaMinutes: 60n,
});

const page = await query.fetch();

console.log("[ARKIV SLICE 1A CANONICAL QUERY]");
console.log(`network: ${tiramisu.name}`);
console.log(`chainId: ${await publicClient.getChainId()}`);
console.log(`query: ${query}`);
console.log(`resultCount: ${page.entities.length}`);
console.log("status: PASS");
