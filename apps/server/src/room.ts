import { randomBytes, randomUUID, randomInt } from "node:crypto";
import type { Server, Socket } from "socket.io";
import { GameEngine, RuleError } from "../../../packages/game/src/index.js";
import type {
  Ack,
  CommandEnvelope,
  GameCommand,
  PlayerView,
  SpectatorView,
} from "../../../packages/game/src/types.js";

interface Seat {
  id: string;
  name: string;
  token: string;
  socketId?: string;
  ready: boolean;
  requests: Map<string, Omit<Ack, "view">>;
}
export interface RoomOptions {
  now?: () => number;
  random?: () => number;
  tickInterval?: number;
}
/** All entry points are synchronous: Node's event loop serializes commands and timeouts. */
export class Room {
  private seats: Seat[] = [];
  private watchers = new Set<string>();
  private version = 0;
  private hostId = "";
  private emptySince?: number;
  engine?: GameEngine;
  private now: () => number;
  private random: () => number;
  constructor(
    private io: Server,
    options: RoomOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.random =
      options.random ?? (() => randomInt(0, 0x100000000) / 0x100000000);
    io.on("connection", (socket) => this.connect(socket));
  }
  private seat(socket: Socket) {
    return this.seats.find((s) => s.socketId === socket.id);
  }
  private view(seat: Seat, now: number): PlayerView {
    const view: PlayerView = this.engine?.view(seat.id, now) ?? {
      role: "player",
      version: this.version,
      serverNow: now,
      phase: "lobby",
      selfId: seat.id,
      hostId: this.hostId,
      players: [],
      round: 0,
      deckCount: 0,
      logs: [],
    };
    view.version = this.version;
    view.hostId = this.hostId;
    view.players = this.seats.map((s) => ({
      id: s.id,
      name: s.name,
      total: 0,
      resetUsed: false,
      hand: [],
      ...view.players.find((p) => p.id === s.id),
      connected: !!s.socketId,
      ready: s.ready,
    }));
    return view;
  }
  private spectatorView(now: number): SpectatorView {
    const view: SpectatorView = this.engine?.spectatorView(now) ?? {
      role: "spectator",
      version: this.version,
      serverNow: now,
      phase: "lobby",
      hostId: this.hostId,
      players: [],
      round: 0,
      deckCount: 0,
      logs: [],
    };
    view.version = this.version;
    view.hostId = this.hostId;
    view.players = this.seats.map((seat) => ({
      id: seat.id,
      name: seat.name,
      total: 0,
      resetUsed: false,
      hand: [],
      ...view.players.find((player) => player.id === seat.id),
      connected: !!seat.socketId,
      ready: seat.ready,
    }));
    return view;
  }
  private migrateHost() {
    if (!this.seats.some((s) => s.id === this.hostId && s.socketId))
      this.hostId =
        this.seats.find((s) => s.socketId)?.id ?? this.seats[0]?.id ?? "";
  }
  private broadcast(now: number) {
    if (this.watchers.size) {
      const view = this.spectatorView(now);
      for (const id of this.watchers) this.io.to(id).emit("state", view);
    }
    for (const s of this.seats)
      if (s.socketId) this.io.to(s.socketId).emit("state", this.view(s, now));
  }
  private changed(now: number) {
    this.version++;
    this.broadcast(now);
  }
  tick(now = this.now()) {
    let changed = this.engine?.tick(now) ?? false;
    if (
      !this.engine &&
      this.seats.length &&
      !this.seats.some((s) => s.socketId)
    ) {
      this.emptySince ??= now;
      if (now - this.emptySince >= 60000) {
        this.seats = [];
        this.hostId = "";
        this.emptySince = undefined;
        changed = true;
      }
    } else this.emptySince = undefined;
    if (changed) this.changed(now);
  }
  private remove(seat: Seat) {
    this.seats = this.seats.filter((s) => s !== seat);
    if (seat.socketId) {
      const socket = this.io.sockets.sockets.get(seat.socketId);
      setImmediate(() => {
        socket?.emit("removed");
        socket?.disconnect(true);
      });
    }
    this.migrateHost();
  }
  private connect(socket: Socket) {
    let watched = false;
    let budget = 100;
    let budgetAt = this.now();
    const rate = (now: number) => {
      if (now - budgetAt >= 10000) {
        budget = 100;
        budgetAt = now;
      }
      return --budget >= 0;
    };
    const reply = (ack: unknown, value: unknown, result?: string) => {
      if (typeof ack === "function") ack(value, result);
    };
    const onRequest = (
      event: string,
      handler: (input: unknown, ack: unknown) => void,
    ) => {
      socket.on(event, (input: unknown, ack: unknown) => {
        const started = performance.now();
        if (event === "sync" && typeof input === "function") {
          ack = input;
          input = undefined;
        }
        const record =
          input && typeof input === "object"
            ? (input as Record<string, unknown>)
            : undefined;
        const id = record?.requestId;
        const requestId =
          typeof id === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(id)
            ? id
            : undefined;
        const command = record?.command;
        const kind =
          command && typeof command === "object"
            ? (command as Record<string, unknown>).type
            : undefined;
        const step =
          event === "command" &&
          typeof kind === "string" &&
          commandSteps.has(kind)
            ? kind
            : event;
        handler(input, (value: Ack, cachedResult?: string) => {
          const entry = {
            side: "server",
            step,
            phase: "handle",
            durationMs: performance.now() - started,
            result:
              cachedResult ??
              (value.ok ? "ok" : `error:${value.error?.code ?? "INPUT"}`),
            ...(requestId ? { requestId } : {}),
          };
          setImmediate(() =>
            console.log("[cabo-timing]", JSON.stringify(entry)),
          );
          if (typeof ack === "function") ack(value);
        });
      });
    };
    onRequest("watch", (_input, ack) => {
      const now = this.now();
      this.tick(now);
      if (!rate(now))
        return reply(ack, {
          ok: false,
          error: { code: "RATE", message: "操作太快，请稍后再试" },
        });
      if (this.seat(socket))
        return reply(ack, {
          ok: false,
          error: { code: "JOINED", message: "玩家不能同时观战" },
        });
      watched = true;
      this.watchers.add(socket.id);
      const view = this.spectatorView(now);
      socket.emit("state", view);
      reply(ack, { ok: true, view });
    });
    onRequest("unwatch", (_input, ack) => {
      this.watchers.delete(socket.id);
      reply(ack, { ok: true });
    });
    onRequest("join", (input: unknown, ack: unknown) => {
      const now = this.now();
      this.tick(now);
      if (!rate(now))
        return reply(ack, {
          ok: false,
          error: { code: "RATE", message: "操作太快，请稍后再试" },
        });
      if (watched)
        return reply(ack, {
          ok: false,
          error: { code: "SPECTATOR", message: "请退出观战后使用新的连接入座" },
        });
      if (this.seat(socket))
        return reply(ack, {
          ok: false,
          error: { code: "JOINED", message: "已经入座" },
        });
      if (!input || typeof input !== "object")
        return reply(ack, {
          ok: false,
          error: { code: "INPUT", message: "请输入昵称" },
        });
      const { token, name } = input as { token?: unknown; name?: unknown };
      let seat: Seat | undefined;
      if (token !== undefined && token !== null && token !== "") {
        seat =
          typeof token === "string"
            ? this.seats.find((s) => s.token === token)
            : undefined;
        if (!seat)
          return reply(ack, {
            ok: false,
            error: { code: "SESSION", message: "身份已失效，请重新入座" },
          });
        const previous = seat.socketId;
        seat.socketId = socket.id;
        if (previous) {
          const old = this.io.sockets.sockets.get(previous);
          old?.emit("takenOver");
          old?.disconnect(true);
        }
      } else {
        if (this.engine)
          return reply(ack, {
            ok: false,
            error: { code: "STARTED", message: "游戏已开始，请等待本场结束" },
          });
        if (this.seats.length >= 4)
          return reply(ack, {
            ok: false,
            error: { code: "FULL", message: "房间已满（最多4人）" },
          });
        if (
          typeof name !== "string" ||
          !name.trim() ||
          name.trim().length > 24 ||
          /[\x00-\x1f]/.test(name)
        )
          return reply(ack, {
            ok: false,
            error: { code: "NAME", message: "昵称须为1–24个字符" },
          });
        seat = {
          id: randomUUID(),
          name: name.trim(),
          token: randomBytes(32).toString("hex"),
          socketId: socket.id,
          ready: false,
          requests: new Map(),
        };
        this.seats.push(seat);
      }
      this.emptySince = undefined;
      this.migrateHost();
      this.changed(now);
      reply(ack, { ok: true, token: seat.token, view: this.view(seat, now) });
    });
    onRequest("sync", (_input: unknown, ack: unknown) => {
      const now = this.now();
      this.tick(now);
      const seat = this.seat(socket);
      reply(
        ack,
        this.watchers.has(socket.id)
          ? { ok: true, view: this.spectatorView(now) }
          : seat
            ? { ok: true, view: this.view(seat, now) }
            : {
                ok: false,
                error: { code: "SESSION", message: "请先入座或观战" },
              },
      );
    });
    onRequest("command", (input: unknown, ack: unknown) => {
      const now = this.now();
      this.tick(now);
      const seat = this.seat(socket);
      if (watched)
        return reply(ack, {
          ok: false,
          error: { code: "SPECTATOR", message: "观战连接不能操作牌局" },
        });
      if (!seat)
        return reply(ack, {
          ok: false,
          error: { code: "SESSION", message: "连接身份已失效" },
        });
      const respond = (a: Omit<Ack, "view">, cached = false) =>
        reply(
          ack,
          {
            ...a,
            view: this.seats.includes(seat) ? this.view(seat, now) : undefined,
          },
          cached ? `cached:${a.ok ? "ok" : "error"}` : undefined,
        );
      if (!rate(now))
        return respond({
          ok: false,
          error: { code: "RATE", message: "操作太快，请稍后再试" },
        });
      if (!validEnvelope(input))
        return respond({
          ok: false,
          error: { code: "INPUT", message: "操作格式错误" },
        });
      const cached = seat.requests.get(input.requestId);
      if (cached) return respond(cached, true);
      let result: Omit<Ack, "view">;
      try {
        if (input.version !== this.version)
          throw new RuleError("STALE", "牌局已更新，请重新操作");
        this.execute(seat, input.command, now);
        this.changed(now);
        result = { ok: true };
      } catch (error) {
        result = {
          ok: false,
          error:
            error instanceof RuleError
              ? { code: error.code, message: error.message }
              : { code: "INPUT", message: "无效操作" },
        };
      }
      seat.requests.set(input.requestId, result);
      if (seat.requests.size > 256)
        seat.requests.delete(seat.requests.keys().next().value!);
      respond(result);
    });
    socket.on("disconnect", () => {
      this.watchers.delete(socket.id);
      const now = this.now();
      const seat = this.seat(socket);
      if (!seat) return;
      seat.socketId = undefined;
      this.migrateHost();
      if (!this.engine && !this.seats.some((s) => s.socketId))
        this.emptySince = now;
      this.changed(now);
    });
  }
  private execute(seat: Seat, command: GameCommand, now: number) {
    const host = () => {
      if (seat.id !== this.hostId) throw new RuleError("HOST", "仅房主可操作");
    };
    const lobby = () => {
      if (this.engine) throw new RuleError("PHASE", "请在大厅操作");
    };
    switch (command.type) {
      case "ready":
        lobby();
        seat.ready = command.ready;
        return;
      case "start":
        host();
        lobby();
        if (
          this.seats.length < 2 ||
          !this.seats.every((s) => s.ready && s.socketId)
        )
          throw new RuleError("READY", "需要2–4名在线玩家全部准备");
        this.engine = new GameEngine(
          this.seats.map((s) => ({ id: s.id, name: s.name })),
          { random: this.random, now },
        );
        return;
      case "leave":
        lobby();
        this.remove(seat);
        return;
      case "kick": {
        host();
        lobby();
        const target = this.seats.find((s) => s.id === command.targetId);
        if (!target || target === seat)
          throw new RuleError("TARGET", "请选择其他玩家");
        this.remove(target);
        return;
      }
      case "endGame":
        host();
        if (!this.engine || command.confirm !== true)
          throw new RuleError("CONFIRM", "请确认结束整场游戏");
        this.engine = undefined;
        this.seats.forEach((s) => (s.ready = false));
        return;
      case "nextRound":
      case "restart":
        host();
        break;
    }
    if (!this.engine) throw new RuleError("PHASE", "游戏尚未开始");
    this.engine.apply(seat.id, command, now);
  }
}
function validEnvelope(value: unknown): value is CommandEnvelope {
  if (!value || typeof value !== "object") return false;
  const e = value as CommandEnvelope;
  if (
    typeof e.requestId !== "string" ||
    e.requestId.length < 1 ||
    e.requestId.length > 100 ||
    !Number.isSafeInteger(e.version) ||
    !e.command ||
    typeof e.command !== "object"
  )
    return false;
  const c = e.command;
  switch (c.type) {
    case "ready":
      return typeof c.ready === "boolean";
    case "kick":
      return typeof c.targetId === "string";
    case "endGame":
      return c.confirm === true;
    case "draw":
      return c.source === "deck" || c.source === "discard";
    case "initialSelect":
    case "swap":
      return (
        Array.isArray(c.indices) &&
        c.indices.length <= 52 &&
        c.indices.every(Number.isSafeInteger)
      );
    case "exchange":
      return [c.first, c.second].every(
        (position) =>
          position &&
          typeof position === "object" &&
          typeof position.playerId === "string" &&
          Number.isSafeInteger(position.index),
      );
    case "skill":
      return typeof c.targetId === "string" && Number.isSafeInteger(c.index);
    case "start":
    case "leave":
    case "nextRound":
    case "restart":
    case "closeReveal":
    case "discard":
    case "cabo":
      return true;
    default:
      return false;
  }
}

const commandSteps = new Set([
  "ready",
  "start",
  "leave",
  "kick",
  "endGame",
  "nextRound",
  "restart",
  "initialSelect",
  "closeReveal",
  "draw",
  "discard",
  "swap",
  "skill",
  "exchange",
  "cabo",
]);
