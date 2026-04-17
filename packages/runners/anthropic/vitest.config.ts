import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@ageflow/core": resolve(__dirname, "../../core/src/index.ts"),
      "@ageflow/runner-api": resolve(__dirname, "../api/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    passWithNoTests: true,
  },
});
