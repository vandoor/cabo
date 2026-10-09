import { afterEach, expect, it, vi } from "vitest";
import { io, type Socket } from "socket.io-client";
import { createRoomServer } from "./server.js";
import type { GameCommand } from "../../../packages/game/src/types.js";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});
async function fixture() {
  const app = createRoomServer({
    now: () => 1000,
    random: () => 0.31,
    tickInterval: 0,
  });
  await new Promise<void>((resolve) =>
    app.http.listen(0, "127.0.0.1", resolve),
  );
  cleanup.push(() => app.close());
  const port = (app.http.address() as { port: number }).port;
  const connect = async () => {
    const socket = io(`http://127.0.0.1:${port}`, {
      transports: ["websocket"],
      forceNew: true,
      reconnection: false,
    });
    cleanup.push(() => {
      socket.disconnect();
    });
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    return socket;
  };
  let seq = 0;
  const command = async (socket: Socket, command: GameCommand) => {
    const { view } = await socket.emitWithAck("sync");
    return socket.emitWithAck("command", {
      requestId: `test-${++seq}`,
      version: view.version,
      command,
    });
  };
  const watch = async () => {
    const socket = await connect();
    const ack = await socket
      .timeout(500)
      .emitWithAck("watch", { requestId: `watch-${++seq}` });
    expect(ack.ok).toBe(true);
    expect(ack.view.role).toBe("spectator");
    return { socket, view: ack.view };
  };
  return { app, connect, command, watch };
}
function publicOnly(view: Record<string, any>) {
  expect(view.role).toBe("spectator");
  for (const key of [
    "selfId",
    "initial",
    "reveal",
    "pending",
    "swapFeedback",
    "token",
  ])
    expect(view).not.toHaveProperty(key);
  for (const player of view.players)
    for (const card of player.hand)
      if (!card.public && !["roundEnd", "gameOver"].includes(view.phase))
        expect(card).not.toHaveProperty("card");
}
it("watches without taking seats or affecting readiness, host, and commands", async () => {
  const f = await fixture();
  const watcher = await f.watch();
  expect(watcher.view.players).toHaveLength(0);
  const players: Socket[] = [];
  for (let i = 0; i < 4; i++) {
    const player = await f.connect();
    expect((await player.emitWithAck("join", { name: `玩家${i}` })).ok).toBe(
      true,
    );
    players.push(player);
    expect((await f.command(player, { type: "ready", ready: true })).ok).toBe(
      true,
    );
  }
  const before = (await watcher.socket.emitWithAck("sync")).view;
  expect(before.players).toHaveLength(4);
  expect(
    (await watcher.socket.emitWithAck("join", { name: "旁观" })).error.code,
  ).toBe("SPECTATOR");
  expect(
    (await f.command(watcher.socket, { type: "endGame", confirm: true })).error
      .code,
  ).toBe("SPECTATOR");
  expect((await players[0].emitWithAck("watch", {})).error.code).toBe("JOINED");
  expect((await f.command(players[0], { type: "start" })).ok).toBe(true);
  const state = (await watcher.socket.emitWithAck("sync")).view;
  expect(state.hostId).toBe(before.hostId);
  expect(state.phase).toBe("initial");
  publicOnly(state);
});
it("serializes only public state during private actions and resubscribes after reconnect", async () => {
  const f = await fixture();
  const players = [await f.connect(), await f.connect()];
  for (const [i, player] of players.entries()) {
    await player.emitWithAck("join", { name: `玩家${i}` });
    await f.command(player, { type: "ready", ready: true });
  }
  await f.command(players[0], { type: "start" });
  const watcher = await f.watch();
  const packets: Record<string, any>[] = [];
  watcher.socket.on("state", (view) => packets.push(view));
  for (const player of players) {
    const selected = await f.command(player, {
      type: "initialSelect",
      indices: [0, 1],
    });
    expect(selected.view.reveal.cards).toHaveLength(2);
    await f.command(player, { type: "closeReveal" });
  }
  const turn = (await players[0].emitWithAck("sync")).view;
  const actor = turn.selfId === turn.turnPlayerId ? players[0] : players[1];
  const drawn = await f.command(actor, { type: "draw", source: "deck" });
  expect(drawn.view.pending).toBeDefined();
  let state = (
    await watcher.socket.emitWithAck("sync", { requestId: "sync-watch" })
  ).view;
  expect(state.deckCount).toBe(watcher.view.deckCount - 1);
  publicOnly(state);
  await f.command(actor, { type: "swap", indices: [0] });
  expect(packets.length).toBeGreaterThan(0);
  packets.forEach(publicOnly);
  watcher.socket.disconnect();
  const restored = await f.watch();
  expect(restored.view.players).toHaveLength(2);
  publicOnly(restored.view);
  expect(
    (await restored.socket.emitWithAck("unwatch", { requestId: "exit" })).ok,
  ).toBe(true);
  expect((await restored.socket.emitWithAck("sync")).error.code).toBe(
    "SESSION",
  );
  expect(
    (await restored.socket.emitWithAck("join", { name: "转换" })).error.code,
  ).toBe("SPECTATOR");
  await f.command(players[0], { type: "endGame", confirm: true });
  state = (await (await f.watch()).socket.emitWithAck("sync")).view;
  expect(state.phase).toBe("lobby");
});
it("logs safe asynchronous timings for success, rejection, malformed requests and retries", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const f = await fixture();
  const player = await f.connect();
  const joined = await player.emitWithAck("join", {
    name: "secret-name",
    requestId: "join-test",
  });
  const envelope = {
    requestId: "ready-test",
    version: joined.view.version,
    command: { type: "ready", ready: true },
  };
  await player.emitWithAck("command", envelope);
  await player.emitWithAck("command", envelope);
  await player.emitWithAck("command", {
    requestId: "unsafe\nsecret",
    command: { type: "secret-command" },
  });
  const watcher = await f.watch();
  await watcher.socket.emitWithAck("command", {
    requestId: "reject-test",
    version: 0,
    command: { type: "start" },
  });
  await watcher.socket.emitWithAck("sync", { requestId: "sync-test" });
  await watcher.socket.emitWithAck("unwatch", { requestId: "unwatch-test" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const entries = log.mock.calls
    .filter(([prefix]) => prefix === "[cabo-timing]")
    .map(([, json]) => JSON.parse(json));
  for (const step of [
    "join",
    "ready",
    "command",
    "watch",
    "start",
    "sync",
    "unwatch",
  ])
    expect(entries.some((entry) => entry.step === step)).toBe(true);
  expect(
    entries.filter((entry) => entry.requestId === "ready-test"),
  ).toHaveLength(2);
  expect(entries.some((entry) => entry.result === "cached:ok")).toBe(true);
  for (const entry of entries) {
    expect(entry).toMatchObject({ side: "server", phase: "handle" });
    expect(entry.durationMs).toBeGreaterThanOrEqual(0);
    expect(
      Object.keys(entry).every((key) =>
        ["side", "step", "phase", "durationMs", "result", "requestId"].includes(
          key,
        ),
      ),
    ).toBe(true);
  }
  const serialized = JSON.stringify(entries);
  for (const secret of [
    "secret-name",
    "secret-command",
    "unsafe",
    joined.token,
    '"card"',
    '"view"',
  ])
    expect(serialized).not.toContain(secret);
});
