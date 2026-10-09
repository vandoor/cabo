import { protocolHarness } from "../../../tests/support/protocol.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { io, type Socket } from "socket.io-client";
import { createRoomServer } from "./server.js";
import type {
  Ack,
  GameCommand,
  PlayerView,
} from "../../../packages/game/src/types.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function fixture(count = 2) {
  const protocol = protocolHarness();
  let now = 1000;
  const clock = vi.fn(() => now);
  const app = createRoomServer({
    now: clock,
    random: () => 0.31,
    tickInterval: 0,
  });
  await new Promise<void>((r) => app.http.listen(0, "127.0.0.1", r));
  cleanup.push(() => app.close());
  const port = (app.http.address() as { port: number }).port;
  async function connect(name = "玩家", token?: string) {
    const socket = io(`http://127.0.0.1:${port}`, {
      transports: ["websocket"],
      forceNew: true,
      reconnection: false,
    });
    cleanup.push(async () => {
      socket.disconnect();
    });
    await new Promise<void>((r) => socket.on("connect", r));
    protocol.attach(socket);
    const joined = await socket.emitWithAck("join", { name, token });
    return {
      socket,
      token: joined.token as string,
      view: joined.view as PlayerView,
      joined,
    };
  }
  const clients: Awaited<ReturnType<typeof connect>>[] = [];
  for (let i = 0; i < count; i++) clients.push(await connect(`玩家${i + 1}`));
  let seq = 0;
  async function view(socket: Socket): Promise<PlayerView> {
    return (await socket.emitWithAck("sync")).view;
  }
  async function command(
    socket: Socket,
    cmd: GameCommand,
    version?: number,
    requestId?: string,
  ): Promise<Ack> {
    return socket.emitWithAck("command", {
      requestId: requestId ?? `r-${++seq}`,
      version: version ?? (await view(socket)).version,
      command: cmd,
    });
  }
  async function start() {
    for (const c of clients)
      expect((await command(c.socket, { type: "ready", ready: true })).ok).toBe(
        true,
      );
    expect((await command(clients[0].socket, { type: "start" })).ok).toBe(true);
  }
  async function turns() {
    await start();
    now += 40001;
    app.manager.tick();
  }
  return {
    app,
    clients,
    connect,
    view,
    command,
    start,
    turns,
    clock,
    advance: (n: number) => {
      now += n;
      app.manager.tick();
    },
  };
}
describe("real Socket.IO room", () => {
  it("allows 2–4 ready players, rejects a fifth seat and unauthorized start", async () => {
    const f = await fixture(4);
    expect((await f.connect("第五人")).joined.ok).toBe(false);
    expect((await f.command(f.clients[1].socket, { type: "start" })).ok).toBe(
      false,
    );
    await f.start();
    expect((await f.view(f.clients[0].socket)).phase).toBe("initial");
    expect((await f.connect("迟到")).joined.ok).toBe(false);
  });
  it("rejects malformed and stale requests and does not crash on missing ack", async () => {
    const f = await fixture();
    const s = f.clients[0].socket;
    expect((await s.emitWithAck("command", null)).ok).toBe(false);
    const old = (await f.view(s)).version;
    await f.command(s, { type: "ready", ready: true });
    expect(
      (await f.command(s, { type: "ready", ready: false }, old)).error?.code,
    ).toBe("STALE");
    s.emit("command", { bad: true });
    expect((await f.view(s)).players[0].ready).toBe(true);
  });
  it("deduplicates requests without replaying old private views", async () => {
    const f = await fixture();
    await f.start();
    const s = f.clients[0].socket;
    const v = await f.view(s);
    const id = "peek-once";
    const a = await f.command(
      s,
      { type: "initialSelect", indices: [0, 1] },
      v.version,
      id,
    );
    expect(a.view?.reveal?.cards).toHaveLength(2);
    f.advance(11000);
    const retry = await f.command(
      s,
      { type: "initialSelect", indices: [0, 1] },
      v.version,
      id,
    );
    expect(retry.ok).toBe(true);
    expect(retry.view?.reveal).toBeUndefined();
  });
  it("keeps private cards out of actual opponent payloads and restores pending after takeover", async () => {
    const f = await fixture();
    await f.turns();
    const first = await f.view(f.clients[0].socket);
    const owner = f.clients.find((c) => c.view.selfId === first.turnPlayerId)!;
    const other = f.clients.find((c) => c !== owner)!;
    const packets: PlayerView[] = [];
    other.socket.on("state", (v) => packets.push(v));
    await f.command(owner.socket, { type: "draw", source: "deck" });
    const a = await f.view(owner.socket),
      b = await f.view(other.socket);
    expect(a.pending).toBeDefined();
    expect(b.pending).toBeUndefined();
    for (const p of b.players)
      for (const card of p.hand)
        expect(card).toEqual({ index: card.index, public: false });
    const disconnected = new Promise<void>((resolve) =>
      owner.socket.once("disconnect", () => resolve()),
    );
    const takeover = await f.connect("", owner.token);
    await disconnected;
    expect(takeover.view.selfId).toBe(a.selfId);
    expect(takeover.view.pending).toEqual(a.pending);
    expect(owner.socket.connected).toBe(false);
    expect(
      packets.every((v) => v.pending === undefined && v.reveal === undefined),
    ).toBe(true);
  });
  it("serializes swap feedback only to its owner and preserves its deadline on reconnect", async () => {
    const f = await fixture();
    await f.turns();
    const first = await f.view(f.clients[0].socket);
    const owner = f.clients.find((c) => c.view.selfId === first.turnPlayerId)!;
    const other = f.clients.find((c) => c !== owner)!;
    const packets: PlayerView[] = [];
    other.socket.on("state", (view) => packets.push(view));
    await f.command(owner.socket, { type: "draw", source: "deck" });
    const swapped = await f.command(owner.socket, {
      type: "swap",
      indices: [2],
    });
    const feedback = {
      outcome: "swap-success",
      index: 2,
      deadline: first.serverNow + 5000,
    };
    expect(swapped.view?.swapFeedback).toEqual(feedback);
    expect((await f.view(other.socket)).swapFeedback).toBeUndefined();
    f.advance(1000);
    const restored = await f.connect("", owner.token);
    expect(restored.view.swapFeedback).toEqual(feedback);
    expect(
      restored.view.players.find((p) => p.id === restored.view.selfId)!.hand[2],
    ).toEqual({ index: 2, public: false });
    f.advance(3999);
    expect((await f.view(restored.socket)).swapFeedback).toEqual(feedback);
    f.advance(1);
    const expired = await f.connect("", owner.token);
    expect(expired.view.swapFeedback).toBeUndefined();
    await f.view(other.socket);
    expect(packets.length).toBeGreaterThan(0);
    expect(
      packets.every((view) => !JSON.stringify(view).includes("swapFeedback")),
    ).toBe(true);
  });

  it("exchanges two opponents over the wire and rejects malformed or ambiguous selections", async () => {
    const f = await fixture(3);
    await f.turns();
    const state = f.app.room.engine!.state;
    const actorId = state.players[state.turnIndex].id;
    const actor = f.clients.find((c) => c.view.selfId === actorId)!;
    const [first, second] = state.players.filter((p) => p.id !== actorId);
    const index = state.deck.findIndex((c) => c.rank === 11);
    [state.deck[index], state.deck[state.deck.length - 1]] = [
      state.deck[state.deck.length - 1],
      state.deck[index],
    ];
    await f.command(actor.socket, { type: "draw", source: "deck" });
    const before = structuredClone(state);
    for (const bad of [
      { type: "exchange" },
      {
        type: "exchange",
        first: null,
        second: { playerId: second.id, index: 2 },
      },
      {
        type: "exchange",
        first: { playerId: first.id, index: "0" },
        second: { playerId: second.id, index: 2 },
      },
      {
        type: "exchange",
        first: { playerId: first.id, index: 0 },
        second: { playerId: first.id, index: 2 },
      },
      {
        type: "exchange",
        first: { playerId: first.id, index: 0 },
        second: { playerId: second.id, index: 99 },
      },
      { type: "skill", targetId: first.id, index: 0 },
    ]) {
      expect((await f.command(actor.socket, bad as GameCommand)).ok).toBe(
        false,
      );
      expect(state).toEqual(before);
    }
    const a = structuredClone(first.hand[0]);
    const b = structuredClone(second.hand[2]);
    const response = await f.command(actor.socket, {
      type: "exchange",
      first: { playerId: first.id, index: 0 },
      second: { playerId: second.id, index: 2 },
    });
    expect(response.ok).toBe(true);
    expect(first.hand[0]).toEqual(b);
    expect(second.hand[2]).toEqual(a);
    for (const client of f.clients) {
      const view = await f.view(client.socket);
      expect(view.logs.find((log) => log.skill)?.skill).toEqual({
        actorId,
        kind: "exchange",
      });
      expect(view.reveal).toBeUndefined();
      for (const player of view.players)
        for (const card of player.hand) expect(card.card).toBeUndefined();
    }
  });

  it("drops unexpired swap feedback when returning to the lobby", async () => {
    const f = await fixture();
    await f.turns();
    const first = await f.view(f.clients[0].socket);
    const owner = f.clients.find((c) => c.view.selfId === first.turnPlayerId)!;
    await f.command(owner.socket, { type: "draw", source: "deck" });
    const swapped = await f.command(owner.socket, {
      type: "swap",
      indices: [0],
    });
    expect(swapped.view?.swapFeedback).toBeDefined();
    expect(
      (await f.command(f.clients[0].socket, { type: "endGame", confirm: true }))
        .ok,
    ).toBe(true);
    const lobby = await f.view(owner.socket);
    expect(lobby.phase).toBe("lobby");
    expect(lobby.swapFeedback).toBeUndefined();
    expect(
      (await f.connect("", owner.token)).view.swapFeedback,
    ).toBeUndefined();
  });

  it("expires opening reveals on reconnect and times out disconnected turns", async () => {
    const f = await fixture();
    await f.start();
    const owner = f.clients[0];
    await f.command(owner.socket, { type: "initialSelect", indices: [1, 3] });
    owner.socket.disconnect();
    f.advance(40001);
    const restored = await f.connect("", owner.token);
    expect(restored.view.reveal).toBeUndefined();
    expect(restored.view.phase).toBe("turn");
    const count = restored.view.deckCount;
    f.advance(60001);
    expect((await f.view(restored.socket)).deckCount).toBe(count - 1);
  });
  it("processes the deadline before accepting a late action", async () => {
    const f = await fixture();
    await f.turns();
    const v = await f.view(f.clients[0].socket);
    const owner = f.clients.find((c) => c.view.selfId === v.turnPlayerId)!;
    f.advance(60000);
    const late = await f.command(owner.socket, { type: "cabo" }, v.version);
    expect(late.ok).toBe(false);
    expect(late.view?.caboCallerId).toBeUndefined();
  });
  it("uses a single event timestamp so a next player cannot cross a deadline using an old version", async () => {
    const f = await fixture();
    await f.turns();
    const v = await f.view(f.clients[0].socket);
    const next = f.clients.find((c) => c.view.selfId !== v.turnPlayerId)!;
    f.clock
      .mockReturnValueOnce(v.turnDeadline! - 1)
      .mockReturnValueOnce(v.turnDeadline! - 1)
      .mockReturnValue(v.turnDeadline!);
    const response = await f.command(next.socket, { type: "cabo" }, v.version);
    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe("NOT_YOUR_TURN");
  });
  it("transfers host to the earliest online seat", async () => {
    const f = await fixture(3);
    f.clients[0].socket.disconnect();
    await new Promise((r) => setTimeout(r, 20));
    expect((await f.view(f.clients[1].socket)).hostId).toBe(
      f.clients[1].view.selfId,
    );
  });
  it("clears an entirely offline lobby after five minutes and invalidates tokens", async () => {
    const f = await fixture();
    for (const c of f.clients) c.socket.disconnect();
    await new Promise((r) => setTimeout(r, 20));
    f.advance(300001);
    const stale = await f.connect("", f.clients[0].token);
    expect(stale.joined.ok).toBe(false);
    expect(f.app.manager.rooms.size).toBe(0);
  });
  it("only lets the host end the match with explicit confirmation; leave and kick revoke seats", async () => {
    const f = await fixture();
    await f.start();
    expect(
      (await f.command(f.clients[1].socket, { type: "endGame", confirm: true }))
        .ok,
    ).toBe(false);
    expect(
      (await f.command(f.clients[0].socket, { type: "endGame", confirm: true }))
        .view?.phase,
    ).toBe("lobby");
    const old = f.clients[1].token;
    expect(
      (
        await f.command(f.clients[0].socket, {
          type: "kick",
          targetId: f.clients[1].view.selfId,
        })
      ).ok,
    ).toBe(true);
    expect((await f.connect("", old)).joined.ok).toBe(false);
    expect((await f.command(f.clients[0].socket, { type: "leave" })).ok).toBe(
      true,
    );
  });
});
