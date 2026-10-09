import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  createWriteStream,
  mkdirSync,
  writeFileSync,
  readFileSync,
  renameSync,
} from "node:fs";
import { createServer } from "node:net";
import { performance } from "node:perf_hooks";

const started = performance.now();
const directory = "artifacts/acceptance";
if (existsSync(directory)) {
  const archive = `${directory}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  renameSync(directory, archive);
}
mkdirSync(directory, { recursive: true });
for (const file of [
  "stdout.log",
  "steps.jsonl",
  "server.jsonl",
  "client.jsonl",
])
  writeFileSync(`${directory}/${file}`, "");
const output = createWriteStream(`${directory}/stdout.log`, { flags: "a" });
const steps = createWriteStream(`${directory}/steps.jsonl`, { flags: "a" });
const timings = createWriteStream(`${directory}/server.jsonl`, { flags: "a" });
let stage = "preflight";
let currentStep = "preflight";
let stopping = false;
const groups = new Set();
const tail = [];
function killOwned(roots) {
  // Capture descendants before killing launchers, including browsers that have
  // created their own process group. No unrelated port owner is ever targeted.
  const listing = spawnSync("ps", ["-eo", "pid=,ppid="], {
    encoding: "utf8",
    timeout: 200,
  });
  const owned = new Set(roots);
  const processes = (listing.stdout ?? "")
    .trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number));
  let changed = true;
  while (changed) {
    changed = false;
    for (const [pid, parent] of processes)
      if (owned.has(parent) && !owned.has(pid)) {
        owned.add(pid);
        changed = true;
      }
  }
  for (const pid of [...owned].reverse()) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* Already exited. */
    }
  }
  for (const pid of roots) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") console.error(error.message);
    }
  }
}
const clean = () => {
  killOwned([...groups]);
  groups.clear();
};
const record = (phase, result, since = started) =>
  steps.write(
    JSON.stringify({
      side: "acceptance",
      step: stage,
      phase,
      durationMs: performance.now() - since,
      result,
    }) + "\n",
  );
const reportFailure = (message) => {
  console.error(`[acceptance] ${message}; stage=${stage}; step=${currentStep}`);
  console.error(tail.slice(-12).join("\n"));
  record("finish", message);
};
// Reserve 500 ms for closing logs and owned process groups. The final watchdog
// bounds the entire invocation, including cleanup, at 60 seconds.
const watchdog = setTimeout(
  () => process.exit(1),
  60000 - (performance.now() - started),
);
const deadline = setTimeout(
  () => {
    stopping = true;
    reportFailure("60-second deadline reached (cleanup reserve)");
    clean();
    process.exitCode = 1;
  },
  59500 - (performance.now() - started),
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    stopping = true;
    reportFailure(`interrupted by ${signal}`);
    clean();
    process.exitCode = 1;
  });
function line(text) {
  const plain = text.replace(/\x1b\[[0-9;]*m/g, "");
  tail.push(plain);
  if (tail.length > 20) tail.shift();
  const marker = plain.indexOf("[acceptance-step] ");
  if (marker !== -1)
    currentStep = plain.slice(marker + "[acceptance-step] ".length);
  const match = plain.match(/\[cabo-timing\]\s+(\{.*\})\s*$/);
  if (match) {
    try {
      const row = JSON.parse(match[1]);
      if (row.side === "server") timings.write(JSON.stringify(row) + "\n");
    } catch {
      /* Preserve raw output; malformed diagnostics cannot block play. */
    }
  }
}
async function run(name, args, limit) {
  if (stopping) throw new Error("acceptance interrupted");
  stage = name;
  currentStep = name;
  const since = performance.now();
  record("start", "running", since);
  console.log(`[acceptance] ${name}`);
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (child.pid) groups.add(child.pid);
    let timeout;
    let expired = false;
    const buffers = new Map();
    for (const [stream, destination] of [
      [child.stdout, process.stdout],
      [child.stderr, process.stderr],
    ]) {
      buffers.set(stream, "");
      stream.setEncoding("utf8");
      stream.on("data", (data) => {
        output.write(data);
        destination.write(data);
        const lines = (buffers.get(stream) + data).split("\n");
        buffers.set(stream, lines.pop());
        for (const text of lines) line(text);
      });
    }
    timeout = setTimeout(() => {
      expired = true;
      reportFailure(`${name} exceeded ${limit / 1000} seconds`);
      killOwned([child.pid]);
    }, limit);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      // Also remove descendants left behind by a launcher or failed browser.
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        /* Group already gone. */
      }
      groups.delete(child.pid);
      for (const value of buffers.values()) if (value) line(value);
      record(
        "finish",
        code === 0 && !expired && !stopping ? "ok" : "failed",
        since,
      );
      if (code === 0 && !expired && !stopping) resolve();
      else reject(new Error(`${name} failed (${signal ?? code})`));
    });
  });
}
async function ensureFreePort() {
  await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", (error) =>
      reject(
        new Error(
          `port 3100 unavailable: ${error.code}; existing services will not be reused or stopped`,
        ),
      ),
    );
    probe.listen(3100, "127.0.0.1", () => probe.close(resolve));
  });
}
try {
  for (const path of ["apps/web/dist/index.html", "dist/test-server.js"])
    if (!existsSync(path))
      throw new Error(
        `Missing prebuilt ${path}; run npm run build:acceptance first`,
      );
  await ensureFreePort();
  await run(
    "rules-network",
    [
      "node_modules/vitest/vitest.mjs",
      "run",
      "--config",
      "vitest.acceptance.config.ts",
    ],
    15000,
  );
  await run(
    "browser",
    ["scripts/e2e.mjs", "--config", "playwright.acceptance.config.ts"],
    Math.max(1, 59500 - (performance.now() - started)),
  );
  stage = "timing-log-correlation";
  currentStep = stage;
  const logStarted = performance.now();
  record("start", "running", logStarted);
  await new Promise((resolve) => timings.write("", resolve));
  const parse = (file) =>
    readFileSync(`${directory}/${file}`, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(JSON.parse);
  const serverRows = parse("server.jsonl");
  const clientRows = parse("client.jsonl");
  const allowed = new Set([
    "side",
    "step",
    "phase",
    "durationMs",
    "result",
    "requestId",
  ]);
  if (!serverRows.length || !clientRows.length)
    throw new Error("Missing client/server timing evidence");
  for (const row of serverRows) {
    if (
      row.side !== "server" ||
      row.phase !== "handle" ||
      !Number.isFinite(row.durationMs) ||
      row.durationMs < 0 ||
      typeof row.step !== "string" ||
      typeof row.result !== "string" ||
      Object.keys(row).some((key) => !allowed.has(key)) ||
      (row.requestId !== undefined &&
        (typeof row.requestId !== "string" ||
          !/^[A-Za-z0-9_-]{1,100}$/.test(row.requestId)))
    )
      throw new Error("Invalid or unsafe server timing schema");
  }
  const sends = clientRows.filter((row) => row.phase === "send");
  if (!sends.length) throw new Error("Missing client send timings");
  for (const row of sends)
    if (
      !serverRows.some(
        (server) =>
          server.requestId === row.requestId && server.step === row.step,
      )
    )
      throw new Error(
        `Missing server handle timing for ${row.step} (${row.requestId})`,
      );
  record("finish", "ok", logStarted);
  console.log(
    `[acceptance] correlated ${sends.length} sends with ${serverRows.length} server handles`,
  );
  stage = "complete";
  record("finish", "ok");
  console.log(
    `[acceptance] passed in ${((performance.now() - started) / 1000).toFixed(2)} s; logs: ${directory}`,
  );
} catch (error) {
  reportFailure(error.message);
  process.exitCode = 1;
} finally {
  clean();
  clearTimeout(deadline);
  await Promise.all(
    [output, steps, timings].map(
      (stream) => new Promise((resolve) => stream.end(resolve)),
    ),
  );
  clearTimeout(watchdog);
}
