import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["e2e/**", "node_modules/**", "dist/**"],
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
      "cloudflare:workers": fileURLToPath(
        new URL("./src/server/node-worker-env.ts", import.meta.url),
      ),
    },
  },
});
