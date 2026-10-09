import { afterEach, describe, expect, it } from "vitest";
import { io } from "socket.io-client";
import { RoomClient, type Route } from "./roomClient";
import { IdentityStore, identityKey } from "./session";
import { createRoomServer } from "../../server/src/server";
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});
function memory() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
  };
}
async function waitFor(check: () => boolean) {
  await expect.poll(check, { timeout: 1500, interval: 10 }).toBe(true);
}
async function fixture() {
  const app = createRoomServer({ tickInterval: 0 });
  await new Promise<void>((r) => app.http.listen(0, "127.0.0.1", r));
  cleanup.push(() => app.close());
  const url = `http://127.0.0.1:${(app.http.address() as { port: number }).port}`;
  return { app, url };
}
function make(url: string, db = memory(), route: Route = { watch: false }) {
  const s = io(url, { autoConnect: false, transports: ["websocket"] });
  const store = new IdentityStore(db);
  let currentRoute = route;
  const client = new RoomClient(s, store, route, (r) => {
    currentRoute = r;
  });
  client.start();
  cleanup.push(() => client.stop());
  return {
    s,
    client,
    db,
    store,
    get route() {
      return currentRoute;
    },
  };
}
describe("room recovery client over real sockets", () => {
  it("creates, refreshes and clears reservation after lobby departure", async () => {
    const { url } = await fixture();
    const a = make(url);
    await waitFor(() => a.client.snapshot().status === "ready");
    a.client.create("甲", "测试");
    await waitFor(() => !!a.client.snapshot().view);
    const roomId = a.client.snapshot().view!.roomId;
    expect(a.client.snapshot().myRoomId).toBe(roomId);
    a.client.stop();
    const b = make(url, a.db, { roomId, watch: false });
    await waitFor(() => !!b.client.snapshot().view);
    expect(b.client.snapshot().view!.players).toHaveLength(1);
    b.client.browse();
    await waitFor(() => b.client.snapshot().status === "ready");
    expect(b.client.snapshot().myRoomId).toBeUndefined();
    expect(b.client.snapshot().view).toBeUndefined();
  });
  it("does not let an old page auto restore after a newer page takes over", async () => {
    const { url } = await fixture();
    const a = make(url);
    await waitFor(() => a.client.snapshot().status === "ready");
    a.client.create("甲", "");
    await waitFor(() => !!a.client.snapshot().view);
    const roomId = a.client.snapshot().myRoomId!;
    const b = make(url, a.db, { roomId, watch: false });
    await waitFor(() => !!b.client.snapshot().view);
    await waitFor(() => a.client.snapshot().status === "takenOver");
    a.client.reconnect();
    await new Promise((r) => setTimeout(r, 40));
    expect(a.client.snapshot().view).toBeUndefined();
    expect(b.client.snapshot().view?.players).toHaveLength(1);
    a.client.reconnect(true);
    await waitFor(() => !!a.client.snapshot().view);
    await waitFor(() => b.client.snapshot().status === "takenOver");
  });
  it("recovers committed create whose acknowledgement was lost across refresh", async () => {
    const { app, url } = await fixture();
    let dropped = false;
    app.io.on("connection", (s) =>
      s.use((packet, next) => {
        if (packet[0] === "create" && !dropped) {
          dropped = true;
          packet[packet.length - 1] = () => {};
        }
        next();
      }),
    );
    const a = make(url);
    await waitFor(() => a.client.snapshot().status === "ready");
    a.client.create("甲", "丢确认");
    await waitFor(() => app.manager.rooms.size === 1);
    expect(JSON.parse(a.db.getItem(identityKey)!).pending.event).toBe("create");
    a.client.stop();
    const b = make(url, a.db);
    await waitFor(() => !!b.client.snapshot().view);
    expect(b.client.snapshot().view!.players).toHaveLength(1);
    expect(app.manager.rooms.size).toBe(1);
  });
  it("does not confuse another operation at the next generation with its own lost acknowledgement", async () => {
    const { url } = await fixture();
    const a = make(url);
    await waitFor(() => a.client.snapshot().status === "ready");
    const old = JSON.parse(a.db.getItem(identityKey)!);
    a.client.stop();
    const b = make(url, a.db);
    await waitFor(() => b.client.snapshot().status === "ready");
    b.client.create("新页", "");
    await waitFor(() => !!b.client.snapshot().view);
    const oldDb = memory();
    oldDb.setItem(
      identityKey,
      JSON.stringify({
        ...old,
        pending: {
          event: "create",
          data: { ...old, requestId: "never-delivered", name: "旧页" },
        },
      }),
    );
    const stale = make(url, oldDb);
    await waitFor(() => stale.client.snapshot().status === "takenOver");
    expect(stale.client.snapshot().view).toBeUndefined();
    expect(b.client.snapshot().status).toBe("ready");
  });
  it("losing browse acknowledgement preserves list destination after refresh", async () => {
    const { app, url } = await fixture();
    const a = make(url);
    await waitFor(() => a.client.snapshot().status === "ready");
    a.client.create("甲", "");
    await waitFor(() => !!a.client.snapshot().view);
    const b = make(url);
    await waitFor(() => b.client.snapshot().status === "ready");
    b.client.join(a.client.snapshot().myRoomId!, "乙");
    await waitFor(() => !!b.client.snapshot().view);
    await a.client.send({ type: "ready", ready: true });
    await waitFor(() => !!b.client.snapshot().view?.players[0].ready);
    await b.client.send({ type: "ready", ready: true });
    await waitFor(
      () => !!a.client.snapshot().view?.players.every((p) => p.ready),
    );
    expect(await a.client.send({ type: "start" })).toBe(true);
    for (const sock of app.io.sockets.sockets.values())
      sock.use((packet, next) => {
        if (packet[0] === "browse") packet[packet.length - 1] = () => {};
        next();
      });
    a.client.browse();
    await waitFor(
      () => app.room.seats.filter((s) => !!s.socketId).length === 1,
    );
    a.client.stop();
    const restored = make(url, a.db, a.route);
    await waitFor(() => restored.client.snapshot().status === "ready");
    expect(restored.client.snapshot().view).toBeUndefined();
    expect(restored.route.roomId).toBeUndefined();
    expect(restored.client.snapshot().myRoomId).toBeDefined();
  });
  it("blocks seating on unavailable storage but still permits spectating", async () => {
    const { app, url } = await fixture();
    const host = make(url);
    await waitFor(() => host.client.snapshot().status === "ready");
    host.client.create("房主", "");
    await waitFor(() => !!host.client.snapshot().view);
    const db = memory();
    db.setItem = () => {
      throw Error("blocked");
    };
    const visitor = make(url, db);
    await waitFor(() => visitor.client.snapshot().status === "ready");
    visitor.client.create("不能保存", "");
    await waitFor(() => visitor.client.snapshot().status === "invalid");
    expect(app.manager.rooms.size).toBe(1);
    expect(visitor.client.snapshot().error).toContain("存储");
    visitor.client.watch(host.client.snapshot().myRoomId!);
    await waitFor(() => visitor.client.snapshot().view?.role === "spectator");
  });
  it.each(["join", "restore"])(
    "recovers a lost %s ack after refresh without duplicate seats",
    async (event) => {
      const { app, url } = await fixture();
      const host = make(url);
      await waitFor(() => host.client.snapshot().status === "ready");
      host.client.create("甲", "");
      await waitFor(() => !!host.client.snapshot().view);
      let dropped = false;
      app.io.on("connection", (s) =>
        s.use((packet, next) => {
          if (packet[0] === event && !dropped) {
            dropped = true;
            packet[packet.length - 1] = () => {};
          }
          next();
        }),
      );
      let owner = make(url);
      await waitFor(() => owner.client.snapshot().status === "ready");
      owner.client.join(host.client.snapshot().myRoomId!, "乙");
      if (event === "restore") {
        await waitFor(() => !!owner.client.snapshot().view);
        owner.client.stop();
        owner = make(url, owner.db, owner.route);
      }
      await waitFor(() => dropped);
      await waitFor(() => app.room.seats.length === 2);
      owner.client.stop();
      const restored = make(url, owner.db, owner.route);
      await waitFor(() => !!restored.client.snapshot().view);
      expect(restored.client.snapshot().view!.players).toHaveLength(2);
    },
  );
  it("retains credentials and retries a temporary restore rate rejection automatically", async () => {
    const { app, url } = await fixture();
    const a = make(url);
    await waitFor(() => a.client.snapshot().status === "ready");
    a.client.create("甲", "");
    await waitFor(() => !!a.client.snapshot().view);
    a.client.stop();
    let rejected = false;
    app.io.on("connection", (s) =>
      s.use((packet, next) => {
        if (packet[0] === "restore" && !rejected) {
          rejected = true;
          (packet[packet.length - 1] as Function)({
            ok: false,
            error: { code: "RATE", message: "临时限流" },
          });
          return;
        }
        next();
      }),
    );
    const b = make(url, a.db, a.route);
    await waitFor(() => b.client.snapshot().status === "retrying");
    expect(JSON.parse(b.db.getItem(identityKey)!).token).toBeDefined();
    await waitFor(() => !!b.client.snapshot().view);
    expect(b.client.snapshot().view!.players).toHaveLength(1);
  });
  it("keeps valid seat metadata when a watched target has already closed", async () => {
    const { url } = await fixture();
    const a = make(url);
    await waitFor(() => a.client.snapshot().status === "ready");
    a.client.create("甲", "");
    await waitFor(() => !!a.client.snapshot().view);
    const before = JSON.parse(a.db.getItem(identityKey)!);
    a.client.watch("closed-target");
    await waitFor(() => a.client.snapshot().status === "invalid");
    expect(a.client.snapshot().myRoomId).toBe(before.roomId);
    expect(JSON.parse(a.db.getItem(identityKey)!).token).toBe(before.token);
  });
  it("closing the watched room does not erase a different reserved seat", async () => {
    const { url } = await fixture();
    const a = make(url);
    await waitFor(() => a.client.snapshot().status === "ready");
    a.client.create("甲", "");
    await waitFor(() => !!a.client.snapshot().view);
    const b = make(url);
    await waitFor(() => b.client.snapshot().status === "ready");
    b.client.join(a.client.snapshot().myRoomId!, "乙");
    await waitFor(() => !!b.client.snapshot().view);
    await waitFor(() => a.client.snapshot().view?.players.length === 2);
    await a.client.send({ type: "ready", ready: true });
    await waitFor(() => !!b.client.snapshot().view?.players[0].ready);
    await b.client.send({ type: "ready", ready: true });
    await waitFor(
      () => !!a.client.snapshot().view?.players.every((p) => p.ready),
    );
    expect(await a.client.send({ type: "start" })).toBe(true);
    const reserved = a.client.snapshot().myRoomId!;
    const c = make(url);
    await waitFor(() => c.client.snapshot().status === "ready");
    c.client.create("丙", "");
    await waitFor(() => !!c.client.snapshot().view);
    a.client.watch(c.client.snapshot().myRoomId!);
    await waitFor(() => a.client.snapshot().view?.role === "spectator");
    c.client.close();
    await waitFor(() => !a.client.snapshot().view);
    expect(a.client.snapshot().myRoomId).toBe(reserved);
    a.client.resume();
    await waitFor(() => a.client.snapshot().view?.role === "player");
  });
  it("explicit takeover works from list and spectator destinations", async () => {
    const { url } = await fixture();
    const host = make(url);
    await waitFor(() => host.client.snapshot().status === "ready");
    host.client.create("房主", "");
    await waitFor(() => !!host.client.snapshot().view);
    const a = make(url);
    await waitFor(() => a.client.snapshot().status === "ready");
    a.client.browse();
    await waitFor(() => a.client.snapshot().status === "ready");
    const b = make(url, a.db, {
      roomId: host.client.snapshot().myRoomId,
      watch: true,
    });
    await waitFor(() => b.client.snapshot().status === "takenOver");
    b.client.reconnect(true);
    await waitFor(() => b.client.snapshot().view?.role === "spectator");
    await waitFor(() => a.client.snapshot().status === "takenOver");
    a.client.reconnect(true);
    await waitFor(() => a.client.snapshot().status === "ready");
    await waitFor(() => b.client.snapshot().status === "takenOver");
    expect(a.client.snapshot().view).toBeUndefined();
    a.client.watch(host.client.snapshot().myRoomId!);
    await waitFor(() => a.client.snapshot().view?.role === "spectator");
  });
  it("ignores a delayed watch acknowledgement after browser history navigates away", async () => {
    const { app, url } = await fixture();
    const host = make(url);
    await waitFor(() => host.client.snapshot().status === "ready");
    host.client.create("房主", "");
    await waitFor(() => !!host.client.snapshot().view);
    let release: (() => void) | undefined;
    app.io.on("connection", (s) =>
      s.use((packet, next) => {
        if (packet[0] === "watch") {
          const ack = packet[packet.length - 1] as Function;
          packet[packet.length - 1] = (...args: unknown[]) => {
            release = () => ack(...args);
          };
        }
        next();
      }),
    );
    const a = make(url);
    await waitFor(() => a.client.snapshot().status === "ready");
    a.client.watch(host.client.snapshot().myRoomId!);
    await waitFor(() => !!release);
    a.client.pop({ watch: false });
    await waitFor(() => a.client.snapshot().status === "ready");
    release!();
    await new Promise((r) => setTimeout(r, 20));
    expect(a.client.snapshot().view).toBeUndefined();
    expect(a.route.roomId).toBeUndefined();
  });
  it("invalidates old server credentials without claiming a seat by nickname", async () => {
    const f = await fixture();
    const a = make(f.url);
    await waitFor(() => a.client.snapshot().status === "ready");
    a.client.create("相同昵称", "");
    await waitFor(() => !!a.client.snapshot().view);
    a.client.stop();
    const restarted = await fixture();
    const b = make(restarted.url, a.db, a.route);
    await waitFor(() => b.client.snapshot().status === "invalid");
    expect(b.client.snapshot().error).toContain("服务器已重启");
    expect(restarted.app.manager.rooms.size).toBe(0);
    expect(b.client.snapshot().myRoomId).toBeUndefined();
  });
});
