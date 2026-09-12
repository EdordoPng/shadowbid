export const SWARM_GATEWAY = 'https://api.gateway.ethswarm.org/';

export function createPublicWorkReader(fetchImplementation = fetch) {
  return Object.freeze({
    async downloadData(reference) {
      const response = await fetchImplementation(`${SWARM_GATEWAY}bytes/${reference}`);
      if (!response.ok) throw new Error(`Swarm retrieval failed with HTTP ${response.status}.`);
      return new Uint8Array(await response.arrayBuffer());
    },
  });
}
