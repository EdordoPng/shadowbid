import { SwarmIdClient } from '@snaha/swarm-id';

// Same Swarm ID origin/API as the verified specification smoke path.
export function createWorkStorage(onConnectionChange) {
  let client;
  let initialized = false;
  return {
    async connect() {
      client ??= new SwarmIdClient({
        iframeOrigin: 'https://swarm-id.snaha.net', containerId: 'swarm-id-container',
        metadata: { name: 'ShadowBid Work Capsule', description: 'User-owned work data' },
        onConnectionChange,
      });
      if (!initialized) { await client.initialize(); initialized = true; }
      await client.connect();
      onConnectionChange(client.connectionInfo);
    },
    get client() {
      if (!client?.connectionInfo.identity || !client.connectionInfo.canUpload) throw new Error('Connect Swarm ID with upload enabled.');
      return client;
    },
  };
}
