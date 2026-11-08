import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      // "server-only" throws outside a React Server bundle; tests run server code directly.
      "server-only": path.resolve(__dirname, "src/test/empty.ts"),
    },
  },
  test: { environment: "node" },
});
