import { randomBytes, randomUUID } from "node:crypto";
import type { Server, Socket } from "socket.io";
import { RuleError } from "../../../packages/game/src/index.js";
import type {
  BrowserSession,
  ManagementAck,
  ScopedRoomView,
} from "../../../packages/game/src/types.js";
import { Room, validEnvelope, type RoomOptions, type Seat } from "./room.js";
interface Receipt {
  event: string;
  roomId?: string;
  generation: number;
}
interface Identity {
  browserId: string;
  secret: string;
  generation: number;
  token?: string;
  roomId?: string;
  ownerSocketId?: string;
  requests: Map<string, Receipt>;
}
interface Connection {
  identity?: Identity;
  generation: number;
  roomId?: string;
  role?: "player" | "spectator";
  budget: number;
  budgetAt: number;
}
type Input = Record<string, unknown>;
const fail = (code: string, message: string): never => {
  throw new RuleError(code, message);
};
export class RoomManager {
  readonly rooms = new Map<string, Room>();
  readonly serverId = randomUUID();
  private identities = new Map<string, Identity>();
  private connections = new Map<string, Connection>();
  private now: () => number;
  private lastSummary = "";
  constructor(
    private io: Server,
    private options: RoomOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    io.on("connection", (s) => this.connect(s));
  }
  private session(identity: Identity): BrowserSession {
    const seat = this.rooms
      .get(identity.roomId ?? "")
      ?.seats.find((s) => s.browserId === identity.browserId);
    return {
      browserId: identity.browserId,
      generation: identity.generation,
      connected: !!seat?.socketId,
      ...(seat
        ? { roomId: identity.roomId, playerId: seat.id, token: identity.token }
        : {}),
    };
  }
  private view(c: Connection, now: number): ScopedRoomView | undefined {
    const room = this.rooms.get(c.roomId ?? "");
    if (!room || !c.role) return;
    const seat =
      c.role === "player"
        ? room.seats.find((s) => s.browserId === c.identity?.browserId)
        : undefined;
    if (c.role === "player" && !seat) return;
    return {
      ...room.view(seat, now),
      roomId: room.id,
      serverId: this.serverId,
      generation: c.generation,
    };
  }
  private result(c: Connection, now: number): ManagementAck {
    return {
      ok: true,
      serverId: this.serverId,
      ...(c.identity ? { session: this.session(c.identity) } : {}),
      view: this.view(c, now),
      rooms: this.summary(),
    };
  }
  private summary() {
    return [...this.rooms.values()].map((r) => r.summary());
  }
  private summaries(forceSocket?: Socket) {
    const rooms = this.summary(),
      encoded = JSON.stringify(rooms);
    if (forceSocket) {
      forceSocket.emit("rooms", {
        serverId: this.serverId,
        generation: this.connections.get(forceSocket.id)?.generation ?? 0,
        rooms,
      });
      return;
    }
    if (encoded === this.lastSummary) return;
    this.lastSummary = encoded;
    for (const [id, c] of this.connections)
      this.io.to(id).emit("rooms", {
        serverId: this.serverId,
        generation: c.generation,
        rooms,
      });
  }
  private broadcast(room: Room, now: number) {
    for (const [id, c] of this.connections)
      if (c.roomId === room.id) {
        const view = this.view(c, now);
        if (view) this.io.to(id).emit("state", view);
      }
  }
  private changed(room: Room, now: number) {
    room.changed(now);
    this.broadcast(room, now);
    this.summaries();
  }
  tick(now = this.now()) {
    for (const room of [...this.rooms.values()]) {
      if (room.emptySince !== undefined && now - room.emptySince >= 300000) {
        this.closeRoom(room, "offline", now);
        continue;
      }
      if (room.tick(now)) this.broadcast(room, now);
    }
    this.summaries();
  }
  private notify(
    id: string,
    event: string,
    roomId: string,
    generation: number,
    reason: string,
  ) {
    this.io
      .to(id)
      .emit(event, { roomId, serverId: this.serverId, generation, reason });
  }
  private closeRoom(room: Room, reason: string, now: number) {
    this.rooms.delete(room.id);
    for (const [id, c] of this.connections) {
      if (c.roomId === room.id || c.identity?.roomId === room.id) {
        this.notify(id, "roomClosed", room.id, c.generation, reason);
        if (c.roomId === room.id) {
          c.roomId = undefined;
          c.role = undefined;
        }
      }
    }
    for (const identity of this.identities.values())
      if (identity.roomId === room.id) {
        identity.roomId = undefined;
        identity.token = undefined;
      }
    this.summaries();
  }
  private releaseSeat(room: Room, seat: Seat, reason: string, now: number) {
    const identity = this.identities.get(seat.browserId);
    if (identity) {
      identity.roomId = undefined;
      identity.token = undefined;
    }
    const socketId = seat.socketId ?? identity?.ownerSocketId;
    if (socketId && reason !== "left" && reason !== "switched") {
      const c = this.connections.get(socketId);
      if (c) {
        this.notify(socketId, "removed", room.id, c.generation, reason);
        if (c.roomId === room.id && c.role === "player") {
          c.roomId = undefined;
          c.role = undefined;
        }
      }
    }
    room.remove(seat);
    if (!room.seats.length) this.closeRoom(room, "empty", now);
    else this.changed(room, now);
  }
  /** Stop viewing; active seats remain reserved, lobby seats are relinquished. */
  private detach(
    socket: Socket,
    c: Connection,
    now: number,
    releaseLobby: boolean,
  ) {
    const room = this.rooms.get(c.roomId ?? "");
    if (!room) return;
    room.watchers.delete(socket.id);
    const seat = room.seats.find((s) => s.socketId === socket.id);
    c.roomId = undefined;
    c.role = undefined;
    if (seat) {
      seat.socketId = undefined;
      if (releaseLobby && !room.engine) {
        this.releaseSeat(room, seat, "left", now);
        return;
      }
    }
    this.changed(room, now);
  }
  private authenticate(input: Input, c: Connection): Identity {
    if (
      typeof input.browserId !== "string" ||
      input.browserId.length < 8 ||
      input.browserId.length > 100 ||
      typeof input.secret !== "string" ||
      input.secret.length < 32 ||
      input.secret.length > 256
    )
      fail("IDENTITY", "浏览器身份无效");
    let identity = this.identities.get(input.browserId as string);
    if (identity && identity.secret !== input.secret)
      fail("IDENTITY", "浏览器身份无效");
    if (c.identity && c.identity !== identity)
      fail("IDENTITY", "连接身份不能更换");
    if (!identity) {
      identity = {
        browserId: input.browserId as string,
        secret: input.secret as string,
        generation: 0,
        requests: new Map(),
      };
      this.identities.set(identity.browserId, identity);
    }
    c.identity = identity;
    return identity;
  }
  private scope(input: Input, c: Connection, roomRequired = true) {
    if (input.serverId !== this.serverId)
      fail("SERVER", "服务已重启，请刷新房间列表");
    const identity = c.identity;
    if (!identity) fail("SESSION", "请先确认浏览器身份");
    if (
      input.generation !== identity!.generation ||
      c.generation !== identity!.generation
    )
      fail("STALE_SESSION", "此页面身份已过期，请手动接管");
    if (roomRequired && input.roomId !== c.roomId)
      fail("ROOM", "房间已切换，请重新操作");
  }
  private rotate(socket: Socket, c: Connection, identity: Identity) {
    identity.generation++;
    identity.token = identity.roomId
      ? randomBytes(32).toString("hex")
      : undefined;
    identity.ownerSocketId = socket.id;
    c.generation = identity.generation;
  }
  private manage(
    event: string,
    input: Input,
    socket: Socket,
    c: Connection,
    now: number,
  ): ManagementAck {
    const identity = this.authenticate(input, c);
    if (event === "session") {
      // Querying scopes public list updates, but never binds a reserved seat.
      if (!c.role) c.generation = identity.generation;
      const requestId =
        typeof input.pendingRequestId === "string"
          ? input.pendingRequestId
          : undefined;
      const receipt = requestId ? identity.requests.get(requestId) : undefined;
      return {
        ...this.result(c, now),
        ...(receipt ? { receipt: { requestId: requestId!, ...receipt } } : {}),
      };
    }
    if (input.serverId !== this.serverId)
      fail("SERVER", "服务已重启，请刷新房间列表");
    if (
      typeof input.requestId !== "string" ||
      !/^[A-Za-z0-9_-]{1,100}$/.test(input.requestId)
    )
      fail("INPUT", "操作编号无效");
    const cached = identity.requests.get(input.requestId as string);
    if (cached) {
      if (cached.event !== event) fail("INPUT", "操作编号已使用");
      if (cached.roomId && !this.rooms.has(cached.roomId))
        fail("ROOM_CLOSED", "该操作所属房间已关闭");
      if (
        cached.generation !== identity.generation ||
        identity.ownerSocketId !== socket.id
      )
        fail("STALE_SESSION", "此操作已由另一连接处理");
      return this.result(c, now);
    }
    if (input.generation !== identity.generation)
      fail("STALE_SESSION", "此页面身份已过期，请手动接管");
    const reserved = this.rooms.get(identity.roomId ?? "");
    const target =
      typeof input.roomId === "string"
        ? this.rooms.get(input.roomId)
        : undefined;
    if (["join", "restore", "watch", "closeRoom"].includes(event) && !target)
      fail("ROOM_CLOSED", "房间已关闭");
    if (event === "restore") {
      if (!reserved || reserved !== target || input.token !== identity.token)
        fail("SESSION", "座位身份已失效");
      const previous =
        identity.ownerSocketId &&
        this.io.sockets.sockets.get(identity.ownerSocketId);
      if (previous && previous.id !== socket.id && input.takeover !== true)
        fail("IN_USE", "另一个页面正在使用此身份，请确认接管");
      if (previous && previous.id !== socket.id) {
        const old = this.connections.get(previous.id)!;
        this.notify(
          previous.id,
          "takenOver",
          reserved!.id,
          old.generation,
          "takeover",
        );
        this.detach(previous, old, now, false);
        previous.disconnect(true);
      }
      this.detach(socket, c, now, false);
      this.rotate(socket, c, identity);
      const seat = reserved!.seats.find(
        (s) => s.browserId === identity.browserId,
      )!;
      seat.socketId = socket.id;
      c.roomId = reserved!.id;
      c.role = "player";
      this.changed(reserved!, now);
    } else {
      const previous =
        identity.ownerSocketId && identity.ownerSocketId !== socket.id
          ? this.io.sockets.sockets.get(identity.ownerSocketId)
          : undefined;
      if (previous) {
        if (
          (event !== "watch" && event !== "browse") ||
          input.takeover !== true
        )
          fail("IN_USE", "另一个页面正在使用此身份");
        const old = this.connections.get(previous.id)!;
        this.notify(
          previous.id,
          "takenOver",
          old.roomId ?? identity.roomId ?? "",
          old.generation,
          "takeover",
        );
        this.detach(previous, old, now, false);
        previous.disconnect(true);
      }
      if (event === "create" || event === "join") {
        if (event === "join" && reserved === target)
          fail("JOINED", "您已在此房间保留座位，请恢复连接");
        if (reserved?.engine)
          fail("RESERVED", "您在进行中的房间保留了座位，请先返回原房间");
        if (
          typeof input.name !== "string" ||
          !input.name.trim() ||
          input.name.trim().length > 24 ||
          /[\x00-\x1f]/.test(input.name)
        )
          fail("NAME", "昵称须为1–24个字符");
        if (event === "create" && this.rooms.size >= 4)
          fail("ROOM_LIMIT", "最多同时开放4个房间");
        if (event === "join" && target?.engine)
          fail("STARTED", "游戏已开始，请观战");
        if (event === "join" && target!.seats.length >= 4)
          fail("FULL", "房间已满（最多4人）");
        if (
          event === "create" &&
          input.roomName !== undefined &&
          (typeof input.roomName !== "string" ||
            input.roomName.trim().length > 24 ||
            /[\x00-\x1f]/.test(input.roomName))
        )
          fail("NAME", "房间名称最多24个字符");
        this.detach(socket, c, now, true);
        if (reserved && this.rooms.has(reserved.id)) {
          const old = reserved.seats.find(
            (s) => s.browserId === identity.browserId,
          );
          if (old) this.releaseSeat(reserved, old, "switched", now);
        }
        const id = event === "create" ? randomUUID() : target!.id;
        const room =
          event === "create"
            ? new Room(
                id,
                (input.roomName as string | undefined)?.trim() ||
                  `房间 ${id.slice(0, 8)}`,
                this.options,
              )
            : target!;
        if (event === "create") this.rooms.set(id, room);
        room.add(identity.browserId, (input.name as string).trim(), socket.id);
        identity.roomId = id;
        this.rotate(socket, c, identity);
        c.roomId = id;
        c.role = "player";
        this.changed(room, now);
      } else if (event === "watch" || event === "browse") {
        this.detach(socket, c, now, true);
        // A disconnected lobby reservation also releases when switching views.
        if (reserved && !reserved.engine && this.rooms.has(reserved.id)) {
          const seat = reserved.seats.find(
            (s) => s.browserId === identity.browserId,
          );
          if (seat) this.releaseSeat(reserved, seat, "left", now);
        }
        this.rotate(socket, c, identity);
        if (event === "watch" && this.rooms.has(target!.id)) {
          c.roomId = target!.id;
          c.role = "spectator";
          target!.watchers.add(socket.id);
          this.changed(target!, now);
        }
      } else if (event === "closeRoom") {
        this.scope(input, c);
        const seat = target!.seats.find((s) => s.socketId === socket.id);
        if (!seat || seat.id !== target!.hostId)
          fail("HOST", "仅房主可关闭房间");
        if (input.confirm !== true) fail("CONFIRM", "请确认关闭房间");
        this.closeRoom(target!, "host", now);
      }
    }
    identity.requests.set(input.requestId as string, {
      event,
      roomId: event === "closeRoom" ? target!.id : c.roomId,
      generation: identity.generation,
    });
    return this.result(c, now);
  }
  private connect(socket: Socket) {
    const c: Connection = { generation: 0, budget: 100, budgetAt: this.now() };
    this.connections.set(socket.id, c);
    this.summaries(socket);
    for (const event of [
      "session",
      "create",
      "join",
      "restore",
      "watch",
      "browse",
      "closeRoom",
      "command",
      "sync",
    ])
      socket.on(event, (raw: unknown, ack: unknown) => {
        const started = performance.now(),
          now = this.now();
        let result: ManagementAck;
        let cached = false;
        const input = raw && typeof raw === "object" ? (raw as Input) : {};
        try {
          if (now - c.budgetAt >= 10000) {
            c.budget = 100;
            c.budgetAt = now;
          }
          if (--c.budget < 0) fail("RATE", "操作太快，请稍后再试");
          this.tick(now);
          if (event === "command" || event === "sync") {
            this.scope(input, c);
            const room = this.rooms.get(c.roomId ?? "");
            if (!room) fail("SESSION", "请先入座或观战");
            if (event === "command") {
              if (c.role !== "player")
                fail("SPECTATOR", "观战连接不能操作牌局");
              const seat = room!.seats.find((s) => s.socketId === socket.id);
              if (!seat) fail("SESSION", "连接身份已失效");
              if (!validEnvelope(raw)) fail("INPUT", "操作格式错误");
              const envelope =
                raw as import("../../../packages/game/src/types.js").CommandEnvelope;
              const previous = seat!.requests.get(envelope.requestId);
              if (previous) {
                cached = true;
                result = { ...this.result(c, now), ...previous };
              } else {
                try {
                  if (envelope.version !== room!.version)
                    fail("STALE", "牌局已更新，请重新操作");
                  const removed = room!.execute(seat!, envelope.command, now);
                  if (removed) this.releaseSeat(room!, removed, "removed", now);
                  else this.changed(room!, now);
                  seat!.requests.set(envelope.requestId, { ok: true });
                  result = this.result(c, now);
                } catch (error) {
                  const err =
                    error instanceof RuleError
                      ? { code: error.code, message: error.message }
                      : { code: "INPUT", message: "无效操作" };
                  seat!.requests.set(envelope.requestId, {
                    ok: false,
                    error: err,
                  });
                  result = { ...this.result(c, now), ok: false, error: err };
                }
                if (seat!.requests.size > 256)
                  seat!.requests.delete(seat!.requests.keys().next().value!);
              }
            } else result = this.result(c, now);
          } else result = this.manage(event, input, socket, c, now);
        } catch (error) {
          result = {
            ...this.result(c, now),
            ok: false,
            error:
              error instanceof RuleError
                ? { code: error.code, message: error.message }
                : { code: "INPUT", message: "无效操作" },
          };
        }
        if (typeof ack === "function") ack(result);
        const kind =
          input.command && typeof input.command === "object"
            ? (input.command as Input).type
            : undefined;
        const step =
          event === "command" &&
          typeof kind === "string" &&
          commandSteps.has(kind)
            ? kind
            : event;
        const requestId =
          typeof input.requestId === "string" &&
          /^[A-Za-z0-9_-]{1,100}$/.test(input.requestId)
            ? input.requestId
            : undefined;
        const durationMs = performance.now() - started;
        setImmediate(() =>
          console.log(
            "[cabo-timing]",
            JSON.stringify({
              side: "server",
              step,
              phase: "handle",
              durationMs,
              result: cached
                ? `cached:${result.ok ? "ok" : "error"}`
                : result.ok
                  ? "ok"
                  : `error:${result.error?.code}`,
              ...(requestId ? { requestId } : {}),
            }),
          ),
        );
      });
    socket.on("disconnect", () => {
      this.detach(socket, c, this.now(), false);
      if (c.identity?.ownerSocketId === socket.id)
        c.identity.ownerSocketId = undefined;
      this.connections.delete(socket.id);
    });
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
