import { randomBytes, randomUUID, randomInt } from "node:crypto";
import type { Server, Socket } from "socket.io";
import { GameEngine, RuleError } from "../../../packages/game/src/index.js";
import type {
  Ack,
  CommandEnvelope,
  GameCommand,
  PlayerView,
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
  private migrateHost() {
    if (!this.seats.some((s) => s.id === this.hostId && s.socketId))
      this.hostId =
        this.seats.find((s) => s.socketId)?.id ?? this.seats[0]?.id ?? "";
  }
  private broadcast(now: number) {
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
    let budget = 100;
    let budgetAt = this.now();
    const rate = (now: number) => {
      if (now - budgetAt >= 10000) {
        budget = 100;
        budgetAt = now;
      }
      return --budget >= 0;
    };
    const reply = (ack: unknown, value: unknown) => {
      if (typeof ack === "function") ack(value);
    };
    socket.on("join", (input: unknown, ack: unknown) => {
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
    socket.on("sync", (ack: unknown) => {
      const now = this.now();
      this.tick(now);
      const seat = this.seat(socket);
      reply(
        ack,
        seat
          ? { ok: true, view: this.view(seat, now) }
          : { ok: false, error: { code: "SESSION", message: "请先入座" } },
      );
    });
    socket.on("command", (input: unknown, ack: unknown) => {
      const now = this.now();
      this.tick(now);
      const seat = this.seat(socket);
      if (!seat)
        return reply(ack, {
          ok: false,
          error: { code: "SESSION", message: "连接身份已失效" },
        });
      const respond = (a: Omit<Ack, "view">) =>
        reply(ack, {
          ...a,
          view: this.seats.includes(seat) ? this.view(seat, now) : undefined,
        });
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
      if (cached) return respond(cached);
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
