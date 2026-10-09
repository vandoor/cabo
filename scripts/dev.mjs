import { spawn } from "node:child_process";
const tasks = [
  ["node_modules/tsx/dist/cli.mjs", "watch", "apps/server/src/index.ts"],
  ["node_modules/vite/bin/vite.js", "--config", "apps/web/vite.config.ts"],
];
const children = tasks.map((args) =>
  spawn(process.execPath, args, { stdio: "inherit" }),
);
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  process.exitCode = code;
}
for (const child of children) {
  child.on("error", (error) => {
    console.error(error);
    stop(1);
  });
  child.on("exit", (code) => stop(code ?? 0));
}
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => stop());
