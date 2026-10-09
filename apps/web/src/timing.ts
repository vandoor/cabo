// A deliberately narrow schema: never include commands, names, cards or state.
type Operation = {
  requestId: string;
  step: string;
  start: number;
  result: string;
};
const commits: Operation[] = [];
export function mark(op: Operation, phase: string, result = op.result) {
  const row = {
    side: "client",
    requestId: op.requestId,
    step: op.step,
    phase,
    durationMs: +(performance.now() - op.start).toFixed(3),
    result,
  };
  queueMicrotask(() => console.info("[cabo-timing] " + JSON.stringify(row)));
}
export function startOperation(step: string): Operation {
  const op = {
    requestId:
      globalThis.crypto?.randomUUID?.() ??
      `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
    step,
    start: performance.now(),
    result: "pending",
  };
  mark(op, "start");
  return op;
}
export function completeOperation(op: Operation, result: string) {
  op.result = result;
  mark(op, "ack");
  commits.push(op);
}
export function localOperation(step: string) {
  const op = startOperation(step);
  op.result = "ok";
  commits.push(op);
}
export function commitOperations() {
  for (const op of commits.splice(0)) {
    mark(op, "commit");
    // The second frame follows a paint opportunity; no delay to the action itself.
    requestAnimationFrame(() => requestAnimationFrame(() => mark(op, "paint")));
  }
}
