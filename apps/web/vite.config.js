import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        swarmSmoke: resolve(root, "swarm-smoke.html"),
        deliverySmoke: resolve(root, "delivery-smoke.html"),
      },
    },
  },
});
