import { createPublicClient } from "@arkiv-network/sdk";
import { tiramisu } from "@arkiv-network/sdk/chains";
import { http } from "viem";

const client = createPublicClient({
  chain: tiramisu,
  transport: http(),
});

const blockNumber = await client.getBlockNumber();

console.log("[ARKIV READ SMOKE]");
console.log("network:", tiramisu.name);
console.log("chainId:", tiramisu.id);
console.log("blockNumber:", blockNumber.toString());
console.log("status: PASS");
