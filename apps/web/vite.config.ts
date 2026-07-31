import { cloudflare } from "@cloudflare/vite-plugin";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const appRoot = fileURLToPath(new URL(".", import.meta.url));
  const runtimeEnv = {
    ...loadEnv(mode, appRoot, ""),
    ...process.env,
  };
  const cloudflareRuntime =
    runtimeEnv.FISHMEM_RUNTIME !== "node" &&
    runtimeEnv.FISHMEM_DB !== "libsql" &&
    runtimeEnv.FISHMEM_DB !== "postgres";
  const cloudflareConfigPath = runtimeEnv.FISHMEM_WRANGLER_CONFIG
    ? resolve(appRoot, runtimeEnv.FISHMEM_WRANGLER_CONFIG)
    : undefined;

  return {
    plugins: [
      ...(cloudflareRuntime
        ? [
            cloudflare({
              ...(cloudflareConfigPath
                ? { configPath: cloudflareConfigPath }
                : {}),
              viteEnvironment: { name: "ssr" },
            }),
          ]
        : []),
      tanstackStart(),
      react(),
    ],
    resolve: {
      alias: {
        "@": fileURLToPath(new URL(".", import.meta.url)),
        ...(!cloudflareRuntime
          ? {
              "cloudflare:workers": fileURLToPath(
                new URL("./src/server/node-worker-env.ts", import.meta.url),
              ),
            }
          : {}),
      },
    },
  };
});
