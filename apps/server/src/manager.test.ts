import { afterEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import type { GameCommand } from "../../../packages/game/src/types.js";
import { io, type Socket } from "socket.io-client";
import { createRoomServer } from "./server.js";
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function fixture() {
  let now = 1000;
  const app = createRoomServer({
    now: () => now,
    random: () => 0.31,
    tickInterval: 0,
  });
  await new Promise<void>((r) => app.http.listen(0, "127.0.0.1", r));
  cleanup.push(() => app.close());
  const port = (app.http.address() as { port: number }).port;
  async function connect(
    identity = { browserId: randomUUID(), secret: randomUUID() + randomUUID() },
  ) {
    const socket = io(`http://127.0.0.1:${port}`, {
      transports: ["websocket"],
      forceNew: true,
      reconnection: false,
    });
    cleanup.push(() => {
      socket.disconnect();
    });
    await new Promise<void>((r) => socket.once("connect", r));
    let current: any = await socket
      .timeout(500)
      .emitWithAck("session", { ...identity, requestId: randomUUID() })
      .catch(() => ({ ok: false }));
    const call = async (event: string, extra: any = {}) => {
      const result = await socket.timeout(500).emitWithAck(event, {
        ...identity,
        serverId: current.serverId,
        generation: current.session?.generation,
        requestId: randomUUID(),
        ...extra,
      });
      if (result.session) current = result;
      return result;
    };
    return {
      socket,
      identity,
      call,
      get session() {
        return current.session;
      },
      get serverId() {
        return current.serverId;
      },
    };
  }
  const command = async (
    c: Awaited<ReturnType<typeof connect>>,
    command: any,
  ) => {
    const state = await c.call("sync", { roomId: c.session.roomId });
    return c.call("command", {
      roomId: c.session.roomId,
      version: state.view.version,
      command,
    });
  };
  return {
    app,
    connect,
    command,
    advance(n: number) {
      now += n;
      (app as any).manager.tick();
    },
    async flush() {
      await new Promise((r) => setTimeout(r, 10));
    },
  };
}
it("creates four independent rooms with sixteen seats and public-only summaries", async () => {
  const f = await fixture();
  const clients = [];
  const ids = [];
  for (let r = 0; r < 4; r++) {
    const host = await f.connect();
    expect(host.session).toBeDefined();
    const created = await host.call("create", { name: `host${r}` });
    expect(created.ok).toBe(true);
    ids.push(created.view.roomId);
    clients.push(host);
    expect(created.view.hostId).toBe(created.view.selfId);
    for (let p = 1; p < 4; p++) {
      const c = await f.connect();
      expect((await c.call("join", { roomId: ids[r], name: `p${p}` })).ok).toBe(
        true,
      );
      clients.push(c);
    }
  }
  const extra = await f.connect();
  expect((await extra.call("create", { name: "overflow" })).error.code).toBe(
    "ROOM_LIMIT",
  );
  expect(
    (await extra.call("join", { roomId: ids[0], name: "fifth" })).error.code,
  ).toBe("FULL");
  const queried = await extra.call("session");
  expect(queried.rooms).toHaveLength(4);
  for (const summary of queried.rooms) {
    expect(summary.playerCount).toBe(4);
    expect(Object.keys(summary).sort()).toEqual(
      [
        "hostName",
        "joinable",
        "name",
        "onlineCount",
        "phase",
        "playerCount",
        "roomId",
        "spectatorCount",
      ].sort(),
    );
  }
  for (const c of clients)
    expect((await f.command(c, { type: "ready", ready: true })).ok).toBe(true);
  for (let r = 0; r < 4; r++)
    expect((await f.command(clients[r * 4], { type: "start" })).ok).toBe(true);
  expect(
    (await extra.call("join", { roomId: ids[0], name: "late" })).error.code,
  ).toBe("STARTED");
  const host = clients[0];
  expect(
    (
      await host.call("command", {
        roomId: ids[1],
        version: 0,
        command: { type: "endGame", confirm: true },
      })
    ).error.code,
  ).toBe("ROOM");
});
it("recovers lost create ack, rejects stale restore and never replays closed creation", async () => {
  const f = await fixture();
  const a = await f.connect();
  const requestId = "create-once";
  const created = await a.call("create", { name: "owner", requestId });
  const old = { ...a.session };
  const again = await a.call("create", {
    name: "owner",
    requestId,
    generation: 0,
  });
  expect(again.view.selfId).toBe(created.view.selfId);
  const b = await f.connect(a.identity);
  expect(b.session.roomId).toBe(created.view.roomId);
  expect(
    (await b.call("restore", { roomId: old.roomId, token: old.token })).error
      .code,
  ).toBe("IN_USE");
  const restored = await b.call("restore", {
    roomId: old.roomId,
    token: old.token,
    takeover: true,
  });
  expect(restored.ok).toBe(true);
  expect(restored.session.generation).toBeGreaterThan(old.generation);
  const stale = await f.connect(a.identity);
  expect(
    (
      await stale.call("restore", {
        roomId: old.roomId,
        token: old.token,
        generation: old.generation,
        takeover: true,
      })
    ).error.code,
  ).toBe("STALE_SESSION");
  expect(
    (await b.call("closeRoom", { roomId: old.roomId, confirm: true })).ok,
  ).toBe(true);
  expect(
    (await b.call("create", { name: "owner", requestId, generation: 0 })).error
      .code,
  ).toBe("ROOM_CLOSED");
  expect((f.app as any).manager.rooms.size).toBe(0);
});
it("reserves active seats on browse/watch, releases lobby seats, and expires all-offline rooms after five minutes", async () => {
  const f = await fixture();
  const a = await f.connect(),
    b = await f.connect(),
    spectator = await f.connect();
  await a.call("create", { name: "a" });
  const id = a.session.roomId;
  await b.call("join", { roomId: id, name: "b" });
  await f.command(a, { type: "ready", ready: true });
  await f.command(b, { type: "ready", ready: true });
  await f.command(a, { type: "start" });
  expect((await a.call("browse")).session.roomId).toBe(id);
  expect((await a.call("create", { name: "another" })).error.code).toBe(
    "RESERVED",
  );
  await spectator.call("watch", { roomId: id });
  await b.call("browse");
  f.advance(299999);
  expect((f.app as any).manager.rooms.size).toBe(1);
  await spectator.call("sync", { roomId: id });
  f.advance(1);
  expect((f.app as any).manager.rooms.size).toBe(0);
  const c = await f.connect();
  await c.call("create", { name: "lobby" });
  await c.call("browse");
  expect((f.app as any).manager.rooms.size).toBe(0);
});
it("uses one manager tick, emits only changed room state, and never exposes private opening cards to another room or spectator", async () => {
  const f = await fixture();
  const a = await f.connect(),
    b = await f.connect(),
    other = await f.connect(),
    watcher = await f.connect();
  await a.call("create", { name: "a" });
  const roomId = a.session.roomId;
  await b.call("join", { roomId, name: "b" });
  await other.call("create", { name: "separate" });
  await watcher.call("watch", { roomId });
  await f.command(a, { type: "ready", ready: true });
  await f.command(b, { type: "ready", ready: true });
  await f.command(a, { type: "start" });
  await f.flush();
  const own: any[] = [],
    otherPackets: any[] = [],
    watched: any[] = [];
  a.socket.on("state", (v) => own.push(v));
  other.socket.on("state", (v) => otherPackets.push(v));
  watcher.socket.on("state", (v) => watched.push(v));
  f.advance(1);
  await f.flush();
  expect(own).toHaveLength(0);
  expect(otherPackets).toHaveLength(0);
  const reveal = await f.command(a, { type: "initialSelect", indices: [0, 1] });
  expect(reveal.view.reveal.cards).toHaveLength(2);
  await f.flush();
  expect(otherPackets).toHaveLength(0);
  expect(watched.length).toBeGreaterThan(0);
  for (const packet of watched) {
    expect(packet.roomId).toBe(roomId);
    for (const key of [
      "reveal",
      "initial",
      "pending",
      "swapFeedback",
      "selfId",
    ])
      expect(packet[key]).toBeUndefined();
    for (const p of packet.players)
      for (const card of p.hand) expect(card.card).toBeUndefined();
  }
  f.advance(40001);
  await f.flush();
  expect(own.at(-1).phase).toBe("turn");
  expect(otherPackets).toHaveLength(0);
});
it("closes offline lobbies at five minutes and refuses stale server/spectator actions", async () => {
  const f = await fixture();
  const a = await f.connect(),
    watch = await f.connect();
  await a.call("create", { name: "a" });
  const roomId = a.session.roomId;
  await watch.call("watch", { roomId });
  expect(
    (
      await watch.call("command", {
        roomId,
        version: 0,
        command: { type: "start" },
      })
    ).error.code,
  ).toBe("SPECTATOR");
  expect(
    (await a.call("sync", { roomId, serverId: "old-server" })).error.code,
  ).toBe("SERVER");
  a.socket.disconnect();
  await f.flush();
  f.advance(299999);
  expect((f.app as any).manager.rooms.size).toBe(1);
  f.advance(1);
  expect((f.app as any).manager.rooms.size).toBe(0);
  const returning = await f.connect(a.identity);
  expect(returning.session.roomId).toBeUndefined();
});
it("requires restore for a disconnected lobby reservation in the same room without losing that room", async () => {
  const f = await fixture();
  const a = await f.connect();
  await a.call("create", { name: "a" });
  const roomId = a.session.roomId;
  a.socket.disconnect();
  await f.flush();
  const b = await f.connect(a.identity);
  const attempt = await b.call("join", { roomId, name: "new" });
  expect(attempt.ok).toBe(false);
  expect(attempt.error.code).toBe("JOINED");
  expect((f.app as any).manager.rooms.size).toBe(1);
  expect((await b.call("restore", { roomId, token: b.session.token })).ok).toBe(
    true,
  );
});
it("watching the last lobby seat closes it successfully and a retry stays idempotent", async () => {
  const f = await fixture();
  const a = await f.connect();
  await a.call("create", { name: "a" });
  const roomId = a.session.roomId;
  const generation = a.session.generation;
  const watched = await a.call("watch", {
    roomId,
    requestId: "last-seat-watch",
  });
  expect(watched.ok).toBe(true);
  expect(watched.view).toBeUndefined();
  expect(watched.session.roomId).toBeUndefined();
  expect(watched.session.generation).toBe(generation + 1);
  expect(
    (
      await a.call("watch", {
        roomId,
        requestId: "last-seat-watch",
        generation,
      })
    ).ok,
  ).toBe(true);
});
it("private session queries recover metadata without authorizing another socket or exposing a player view", async () => {
  const f = await fixture();
  const a = await f.connect();
  const created = await a.call("create", { name: "a" });
  const b = await f.connect(a.identity);
  const queried = await b.call("session");
  expect(queried.session.playerId).toBe(created.view.selfId);
  expect(queried.view).toBeUndefined();
  expect(
    (
      await b.call("command", {
        roomId: a.session.roomId,
        version: created.view.version,
        command: { type: "ready", ready: true },
      })
    ).ok,
  ).toBe(false);
  expect(
    (await a.call("sync", { roomId: a.session.roomId })).view.players[0].ready,
  ).toBe(false);
});
it("returns current summaries in management acknowledgements after the generation changes", async () => {
  const f = await fixture();
  const a = await f.connect();
  const created = await a.call("create", {
    name: "a",
    requestId: "summary-create",
  });
  expect(created.rooms).toHaveLength(1);
  const retry = await a.call("create", {
    name: "a",
    requestId: "summary-create",
    generation: 0,
  });
  expect(retry.rooms).toEqual(created.rooms);
  const browsed = await a.call("browse");
  expect(browsed.rooms).toEqual([]);
});
it("proves a lost management acknowledgement only with the exact identity-owned request receipt", async () => {
  const f = await fixture();
  const a = await f.connect();
  const created = await a.call("create", {
    name: "a",
    requestId: "proven-create",
  });
  const b = await f.connect(a.identity);
  const proven = await b.call("session", { pendingRequestId: "proven-create" });
  expect(proven.receipt).toEqual({
    requestId: "proven-create",
    event: "create",
    roomId: created.view.roomId,
    generation: created.session.generation,
  });
  expect(
    (await b.call("session", { pendingRequestId: "different-pending-create" }))
      .receipt,
  ).toBeUndefined();
  const stranger = await f.connect();
  expect(
    (await stranger.call("session", { pendingRequestId: "proven-create" }))
      .receipt,
  ).toBeUndefined();
});
it("notifies an online spectator when their offline reserved seat is kicked, preserving the watched room", async () => {
  const f = await fixture();
  const a = await f.connect(),
    b = await f.connect(),
    other = await f.connect();
  await a.call("create", { name: "a" });
  const roomId = a.session.roomId;
  await b.call("join", { roomId, name: "b" });
  const playerId = b.session.playerId;
  await other.call("create", { name: "other" });
  const watchedRoomId = other.session.roomId;
  await f.command(a, { type: "ready", ready: true });
  await f.command(b, { type: "ready", ready: true });
  await f.command(a, { type: "start" });
  await b.call("watch", { roomId: watchedRoomId });
  const notifications: any[] = [];
  b.socket.on("removed", (v) => notifications.push(v));
  await f.command(a, { type: "endGame", confirm: true });
  await f.command(a, { type: "kick", targetId: playerId });
  await f.flush();
  expect(notifications).toHaveLength(1);
  expect(notifications[0]).toMatchObject({
    roomId,
    generation: b.session.generation,
    reason: "removed",
  });
  const synced = await b.call("sync", { roomId: watchedRoomId });
  expect(synced.ok).toBe(true);
  expect(synced.view.roomId).toBe(watchedRoomId);
  expect(synced.session.roomId).toBeUndefined();
});
it("does not interrupt a voluntary lobby switch with a removal notification before its acknowledgement", async () => {
  const f = await fixture();
  const a = await f.connect();
  await a.call("create", { name: "a" });
  const removed: any[] = [];
  a.socket.on("removed", (v) => removed.push(v));
  const browsed = await a.call("browse");
  await f.flush();
  expect(browsed.ok).toBe(true);
  expect(removed).toEqual([]);
});
it("scopes room-list updates for a refreshed browser without restoring or binding its reserved seat", async () => {
  const f = await fixture();
  const a = await f.connect();
  await a.call("create", { name: "a" });
  const generation = a.session.generation;
  a.socket.disconnect();
  await f.flush();
  const refreshed = await f.connect(a.identity);
  const lists: any[] = [];
  refreshed.socket.on("rooms", (p) => lists.push(p));
  const other = await f.connect();
  await other.call("create", { name: "other" });
  await f.flush();
  expect(lists.at(-1).generation).toBe(generation);
  expect(lists.at(-1).rooms).toHaveLength(2);
  expect(refreshed.session.connected).toBe(false);
  expect(
    (await refreshed.call("sync", { roomId: refreshed.session.roomId })).ok,
  ).toBe(false);
});
it("deduplicates concurrent create requests and refuses another connection or unauthorized room closure", async () => {
  const f = await fixture();
  const owner = await f.connect();
  const request = {
    name: "owner",
    requestId: "concurrent-create",
    generation: 0,
  };
  const results = await Promise.all(
    Array.from({ length: 8 }, () => owner.call("create", request)),
  );
  expect(results.every((r) => r.ok)).toBe(true);
  expect(new Set(results.map((r) => r.view.selfId)).size).toBe(1);
  expect(f.app.manager.rooms.size).toBe(1);
  expect(f.app.room.seats).toHaveLength(1);
  const duplicate = await f.connect(owner.identity);
  expect((await duplicate.call("create", request)).error.code).toBe(
    "STALE_SESSION",
  );
  const guest = await f.connect();
  const roomId = owner.session.roomId;
  await guest.call("join", { roomId, name: "guest" });
  expect(
    (await guest.call("closeRoom", { roomId, confirm: true })).error.code,
  ).toBe("HOST");
  expect(
    (await owner.call("closeRoom", { roomId, confirm: false })).error.code,
  ).toBe("CONFIRM");
  expect(f.app.manager.rooms.size).toBe(1);
  const stranger = await f.connect();
  await stranger.call("watch", { roomId });
  expect(
    (await stranger.call("closeRoom", { roomId, confirm: true })).error.code,
  ).toBe("HOST");
  expect(f.app.room.seats).toHaveLength(2);
});

it("records concurrent command completion for four rooms, sixteen players and four spectators with independent scoring and ticks", async () => {
  const f = await fixture();
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const records: Record<string, unknown>[] = [];
  const durations: number[] = [];
  let logicalRequested = 0,
    logicalCompleted = 0,
    complete = false;
  const clients = await Promise.all(
    Array.from({ length: 20 }, () => f.connect()),
  );
  const groups = Array.from({ length: 4 }, (_, room) =>
    clients.slice(room * 4, room * 4 + 4),
  );
  const watchers = clients.slice(16);
  const roomIds: string[] = [];
  const measured = async (room: number, seat: number, command: GameCommand) => {
    logicalRequested++;
    const client = groups[room][seat];
    for (let attempt = 1; attempt <= 8; attempt++) {
      const state = await client.call("sync", { roomId: roomIds[room] });
      expect(state.ok).toBe(true);
      const start = performance.now();
      let result;
      try {
        result = await client.call("command", {
          roomId: roomIds[room],
          version: state.view.version,
          command,
        });
      } catch (error) {
        records.push({
          kind: "command",
          room,
          seat,
          command: command.type,
          attempt,
          durationMs: performance.now() - start,
          ok: false,
          errorCode: "TIMEOUT",
        });
        throw error;
      }
      const durationMs = performance.now() - start;
      durations.push(durationMs);
      records.push({
        kind: "command",
        room,
        seat,
        command: command.type,
        attempt,
        durationMs,
        ok: result.ok,
        ...(result.error ? { errorCode: result.error.code } : {}),
      });
      if (result.ok) {
        logicalCompleted++;
        return result;
      }
      expect(result.error.code).toBe("STALE");
    }
    throw Error("Optimistic version retries did not complete");
  };
  const actingSeat = (room: number) => {
    const state = f.app.manager.rooms.get(roomIds[room])!.engine!.state;
    return groups[room].findIndex(
      (c) => c.session.playerId === state.players[state.turnIndex].id,
    );
  };
  try {
    const created = await Promise.all(
      groups.map((group, room) =>
        group[0].call("create", { name: `host-${room}` }),
      ),
    );
    for (const result of created) {
      expect(result.ok).toBe(true);
      roomIds.push(result.view.roomId);
    }
    const joined = await Promise.all(
      groups.flatMap((group, room) =>
        group.slice(1).map((client, seat) =>
          client.call("join", {
            roomId: roomIds[room],
            name: `guest-${seat}`,
          }),
        ),
      ),
    );
    expect(joined.every((result) => result.ok)).toBe(true);
    const watched = await Promise.all(
      watchers.map((watcher, room) =>
        watcher.call("watch", { roomId: roomIds[room] }),
      ),
    );
    expect(
      watched.every((result) => result.ok && result.view.role === "spectator"),
    ).toBe(true);
    const spectatorPackets: any[][] = Array.from({ length: 4 }, () => []);
    watchers.forEach((watcher, room) =>
      watcher.socket.on("state", (view) => spectatorPackets[room].push(view)),
    );
    await Promise.all(
      groups.flatMap((group, room) =>
        group.map((_client, seat) =>
          measured(room, seat, { type: "ready", ready: true }),
        ),
      ),
    );
    await Promise.all(
      groups.map((_group, room) => measured(room, 0, { type: "start" })),
    );
    f.advance(40001);
    expect(
      [...f.app.manager.rooms.values()].every(
        (room) => room.engine?.state.phase === "turn",
      ),
    ).toBe(true);
    const initialDecks = roomIds.map(
      (id) => f.app.manager.rooms.get(id)!.engine!.state.deck.length,
    );
    await Promise.all(
      groups.map((_group, room) =>
        measured(room, actingSeat(room), { type: "draw", source: "deck" }),
      ),
    );
    await f.flush();
    for (let room = 0; room < 4; room++) {
      const actor = actingSeat(room);
      const views = await Promise.all(
        groups[room].map((client) =>
          client.call("sync", { roomId: roomIds[room] }),
        ),
      );
      views.forEach((result, seat) =>
        expect(!!result.view.pending).toBe(seat === actor),
      );
    }
    await Promise.all(
      groups.map((_group, room) =>
        measured(room, actingSeat(room), { type: "discard" }),
      ),
    );
    expect(
      roomIds.map(
        (id) => f.app.manager.rooms.get(id)!.engine!.state.deck.length,
      ),
    ).toEqual(initialDecks.map((n) => n - 1));
    const untouched = roomIds
      .slice(2)
      .map((id) => structuredClone(f.app.manager.rooms.get(id)!.engine!.state));
    await Promise.all(
      [0, 1].map((room) => measured(room, actingSeat(room), { type: "cabo" })),
    );
    for (let finalTurn = 0; finalTurn < 3; finalTurn++) {
      await Promise.all(
        [0, 1].map((room) =>
          measured(room, actingSeat(room), { type: "draw", source: "deck" }),
        ),
      );
      await Promise.all(
        [0, 1].map((room) =>
          measured(room, actingSeat(room), { type: "discard" }),
        ),
      );
    }
    for (const room of [0, 1]) {
      const engine = f.app.manager.rooms.get(roomIds[room])!.engine!;
      expect(engine.state.phase).toBe("roundEnd");
      expect(engine.state.results).toHaveLength(4);
      expect(engine.state.players.some((player) => player.total > 0)).toBe(
        true,
      );
      engine.state.results!.forEach((result) =>
        expect(
          engine.state.players.find((player) => player.id === result.playerId)!
            .total,
        ).toBe(result.total),
      );
    }
    expect(
      roomIds.slice(2).map((id) => f.app.manager.rooms.get(id)!.engine!.state),
    ).toEqual(untouched);
    const settled = roomIds
      .slice(0, 2)
      .map((id) => structuredClone(f.app.manager.rooms.get(id)!.engine!.state));
    const versions = roomIds.map((id) => f.app.manager.rooms.get(id)!.version);
    f.advance(60000);
    expect(
      roomIds
        .slice(0, 2)
        .map((id) => f.app.manager.rooms.get(id)!.engine!.state),
    ).toEqual(settled);
    expect(
      roomIds.slice(0, 2).map((id) => f.app.manager.rooms.get(id)!.version),
    ).toEqual(versions.slice(0, 2));
    for (const room of [2, 3]) {
      const current = f.app.manager.rooms.get(roomIds[room])!;
      expect(current.version).toBeGreaterThan(versions[room]);
      expect(current.engine!.state.deck.length).toBe(
        untouched[room - 2].deck.length - 1,
      );
      expect(
        current.engine!.state.players.every((player) => player.total === 0),
      ).toBe(true);
    }
    await Promise.all(
      [0, 1].map((room) => measured(room, 0, { type: "nextRound" })),
    );
    await f.flush();
    spectatorPackets.forEach((packets, room) => {
      expect(packets.length).toBeGreaterThan(0);
      for (const packet of packets) {
        expect(packet.roomId).toBe(roomIds[room]);
        expect(packet.role).toBe("spectator");
        for (const field of [
          "selfId",
          "pending",
          "reveal",
          "initial",
          "swapFeedback",
        ])
          expect(packet[field]).toBeUndefined();
        if (packet.phase !== "roundEnd" && packet.phase !== "gameOver")
          for (const player of packet.players)
            for (const card of player.hand)
              if (!card.public) expect(card.card).toBeUndefined();
      }
    });
    expect(logicalCompleted).toBe(logicalRequested);
    complete = true;
  } finally {
    const sorted = durations.slice().sort((a, b) => a - b);
    mkdirSync("artifacts/four-rooms", { recursive: true });
    const metadata = {
      kind: "run",
      runId,
      startedAt,
      transport: "websocket",
      endpoint: "loopback",
      timer: "injected-clock",
      rooms: 4,
      players: 16,
      spectators: 4,
      measurement: "command emit-to-ack; sync excluded; stale retries retained",
      purpose: "integration validation; not a LAN performance benchmark",
    };
    const summary = {
      kind: "summary",
      runId,
      complete,
      logicalRequested,
      logicalCompleted,
      completionRate: logicalRequested
        ? logicalCompleted / logicalRequested
        : 0,
      attempts: records.length,
      staleAttempts: records.filter((record) => record.errorCode === "STALE")
        .length,
      timeoutAttempts: records.filter(
        (record) => record.errorCode === "TIMEOUT",
      ).length,
      p50Ms: sorted[Math.floor(sorted.length * 0.5)] ?? null,
      p95Ms: sorted[Math.floor(sorted.length * 0.95)] ?? null,
      maxMs: sorted.at(-1) ?? null,
    };
    appendFileSync(
      "artifacts/four-rooms/network.jsonl",
      [metadata, ...records.map((record) => ({ runId, ...record })), summary]
        .map((record) => JSON.stringify(record))
        .join("\n") + "\n",
    );
  }
});
it.each(["watch", "browse"])(
  "allows explicit %s takeover of an identity without a seat and stops the old owner",
  async (event) => {
    const f = await fixture();
    const host = await f.connect();
    await host.call("create", { name: "host" });
    const roomId = host.session.roomId;
    const old = await f.connect();
    await old.call(event, event === "watch" ? { roomId } : {});
    const generation = old.session.generation;
    const notices: any[] = [];
    old.socket.on("takenOver", (message) => notices.push(message));
    const fresh = await f.connect(old.identity);
    const input = event === "watch" ? { roomId } : {};
    expect((await fresh.call(event, input)).error.code).toBe("IN_USE");
    const takeover = await fresh.call(event, { ...input, takeover: true });
    expect(takeover.ok).toBe(true);
    expect(takeover.session.generation).toBe(generation + 1);
    expect(takeover.session.roomId).toBeUndefined();
    await f.flush();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      generation,
      roomId: event === "watch" ? roomId : "",
      reason: "takeover",
    });
    expect(old.socket.connected).toBe(false);
    expect(f.app.manager.rooms.get(roomId)!.watchers.size).toBe(
      event === "watch" ? 1 : 0,
    );
    const stale = await f.connect(old.identity);
    expect(
      (await stale.call(event, { ...input, generation, takeover: true })).error
        .code,
    ).toBe("STALE_SESSION");
  },
);
it("explicit browse takeover disconnects a viewed active seat while preserving its reservation", async () => {
  const f = await fixture();
  const old = await f.connect(),
    guest = await f.connect();
  await old.call("create", { name: "old" });
  const roomId = old.session.roomId;
  await guest.call("join", { roomId, name: "guest" });
  await f.command(old, { type: "ready", ready: true });
  await f.command(guest, { type: "ready", ready: true });
  await f.command(old, { type: "start" });
  const fresh = await f.connect(old.identity);
  const result = await fresh.call("browse", { takeover: true });
  expect(result.ok).toBe(true);
  expect(result.view).toBeUndefined();
  expect(result.session.roomId).toBe(roomId);
  expect(result.session.connected).toBe(false);
  await f.flush();
  expect(old.socket.connected).toBe(false);
  expect(f.app.manager.rooms.get(roomId)!.seats).toHaveLength(2);
  expect(
    (await fresh.call("restore", { roomId, token: fresh.session.token })).ok,
  ).toBe(true);
});
