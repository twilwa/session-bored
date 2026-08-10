// ABOUTME: Runs fast contract and policy tests in a standard TypeScript environment.
// ABOUTME: Keeps unit feedback separate from Worker binding integration tests.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts"],
  },
});
