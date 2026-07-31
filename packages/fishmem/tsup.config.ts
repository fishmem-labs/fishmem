import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  treeshake: true,
  // All optional drivers are dynamically imported, but mark them external so
  // bundlers never try to pull them into the core build.
  external: [
    "@libsql/client",
    "pg",
    "@qdrant/js-client-rest",
    "openai",
    "@anthropic-ai/sdk",
  ],
});
