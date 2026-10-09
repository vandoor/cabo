import { randomInt, randomUUID } from "node:crypto";
import { GameEngine, RuleError } from "../../../packages/game/src/index.js";
import type {
  Ack,
  CommandEnvelope,
  GameCommand,
  PlayerView,
  SpectatorView,
  RoomSummary,
} from "../../../packages/game/src/types.js";
export interface Seat {
  id: string;
  browserId: string;
  name: string;
  socketId?: string;
  ready: boolean;
  requests: Map<string, Omit<Ack, "view">>;
}
export interface RoomOptions {
  now?: () => number;
  random?: () => number;
  tickInterval?: number;
}
/** Pure room state. RoomManager owns sockets, identity, and the single timer. */
export class Room {
  readonly seats: Seat[] = [];
  readonly watchers = new Set<string>();
  version = 0;
  hostId = "";
  emptySince?: number;
  engine?: GameEngine;
  private random: () => number;
  constructor(
    readonly id: string,
    readonly name: string,
    options: RoomOptions = {},
  ) {
    this.random =
      options.random ?? (() => randomInt(0, 0x100000000) / 0x100000000);
  }
  add(browserId: string, name: string, socketId: string) {
    if (this.engine)
      throw new RuleError("STARTED", "游戏已开始，请观战或返回原座位");
    if (this.seats.length >= 4)
      throw new RuleError("FULL", "房间已满（最多4人）");
    const seat: Seat = {
      id: randomUUID(),
      browserId,
      name,
      socketId,
      ready: false,
      requests: new Map(),
    };
    this.seats.push(seat);
    this.migrateHost();
    return seat;
  }
  remove(seat: Seat) {
    const i = this.seats.indexOf(seat);
    if (i >= 0) this.seats.splice(i, 1);
    this.migrateHost();
  }
  migrateHost() {
    if (!this.seats.some((s) => s.id === this.hostId && s.socketId))
      this.hostId =
        this.seats.find((s) => s.socketId)?.id ?? this.seats[0]?.id ?? "";
  }
  changed(now: number) {
    this.version++;
    this.migrateHost();
    if (this.seats.some((s) => s.socketId)) this.emptySince = undefined;
    else this.emptySince ??= now;
  }
  tick(now: number) {
    if (this.engine?.tick(now)) {
      this.changed(now);
      return true;
    }
    return false;
  }
  view(seat: Seat | undefined, now: number): PlayerView | SpectatorView {
    const view: PlayerView | SpectatorView = this.engine
      ? seat
        ? this.engine.view(seat.id, now)
        : this.engine.spectatorView(now)
      : ({
          role: seat ? "player" : "spectator",
          ...(seat ? { selfId: seat.id } : {}),
          version: this.version,
          serverNow: now,
          phase: "lobby",
          hostId: this.hostId,
          players: [],
          round: 0,
          deckCount: 0,
          logs: [],
        } as PlayerView | SpectatorView);
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
  summary(): RoomSummary {
    return {
      roomId: this.id,
      name: this.name,
      phase: this.engine?.state.phase ?? "lobby",
      playerCount: this.seats.length,
      onlineCount: this.seats.filter((s) => s.socketId).length,
      spectatorCount: this.watchers.size,
      hostName: this.seats.find((s) => s.id === this.hostId)?.name ?? "",
      joinable: !this.engine && this.seats.length < 4,
    };
  }
  execute(seat: Seat, command: GameCommand, now: number): Seat | undefined {
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
        return seat;
      case "kick": {
        host();
        lobby();
        const target = this.seats.find((s) => s.id === command.targetId);
        if (!target || target === seat)
          throw new RuleError("TARGET", "请选择其他玩家");
        return target;
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
export function validEnvelope(value: unknown): value is CommandEnvelope {
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
