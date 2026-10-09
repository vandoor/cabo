import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
// Normal machines use `npx playwright install --with-deps chromium webkit`.
// This optional path supports a no-sudo WSL installation of the same libraries.
const libs =
  process.env.CABO_PLAYWRIGHT_LIBS ??
  join(homedir(), ".cache/cabo-playwright-libs/usr/lib/x86_64-linux-gnu");
const env = { ...process.env };
if (existsSync(libs)) {
  env.LD_LIBRARY_PATH = [libs, env.LD_LIBRARY_PATH].filter(Boolean).join(":");
  // Playwright's ldconfig check cannot see user-extracted libs. Real browser
  // launches and every E2E assertion still run; this does not skip any tests.
  env.PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = "1";
}
const child = spawn(
  process.execPath,
  ["node_modules/@playwright/test/cli.js", "test", ...process.argv.slice(2)],
  { stdio: "inherit", env },
);
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
child.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => child.kill(signal));
