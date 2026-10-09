import { defineConfig } from "vitest/config";

// Expiration, offline waiting and cooldown coverage remains explicitly opt-in.
// This partitions tests by purpose even where the test uses a simulated clock.
const timingCases = [
  "expiry",
  "expires",
  "timeout",
  "times out",
  "deadline before",
  "old version",
  "offline lobby",
  "cooldown",
  "auto-selects",
  "delayed tick",
  "deduplicates requests without replaying old private views",
].join("|");
export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts"],
    testNamePattern: new RegExp(
      process.env.CABO_TIMING_ONLY === "1"
        ? timingCases
        : `^(?!.*(?:${timingCases})).*$`,
      "i",
    ),
    testTimeout: 5000,
    retry: 0,
  },
});
