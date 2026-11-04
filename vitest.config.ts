import { defineConfig } from "vitest/config";

const setupFiles = ["./vitest.setup.ts"];

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["{packages,plugins,apps}/*/src/**/*.test.{ts,tsx}"],
          setupFiles,
          testTimeout: 5_000,
        },
      },
      {
        test: {
          name: "integration",
          include: ["{packages,plugins,apps}/*/test/**/*.test.{ts,tsx}"],
          setupFiles,
          testTimeout: 30_000,
          env: { TZ: "America/Los_Angeles" },
        },
      },
    ],
  },
});
