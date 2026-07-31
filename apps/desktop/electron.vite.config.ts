import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  main: {
    plugins: [
      externalizeDepsPlugin({
        // Private workspace packages export TypeScript source for monorepo
        // development. They must be compiled into the main-process bundle:
        // Electron's Node runtime refuses to strip TypeScript below
        // node_modules in a packaged application.
        exclude: ["@fishmem/application", "@fishmem/contracts", "fishmem"],
      }),
    ],
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        output: {
          entryFileNames: "index.cjs",
          format: "cjs",
        },
      },
    },
  },
  renderer: { plugins: [react()] },
});
