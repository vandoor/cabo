import { io, type Socket } from "socket.io-client";
import type {
  GameCommand,
  RoomView,
  RoomSummary,
} from "../../../packages/game/src/types";
import {
  IdentityStore,
  secret,
  retryDelay,
  acceptsScope,
  type SavedIdentity,
} from "./session";
import { startOperation, completeOperation, mark } from "./timing";
type View = RoomView & { serverId: string; roomId: string; generation: number };
type Status =
  "connecting" | "restoring" | "ready" | "retrying" | "invalid" | "takenOver";
type Reply = {
  receipt?: {
    requestId: string;
    event: string;
    roomId?: string;
    generation: number;
  };
  ok: boolean;
  error?: { code: string; message: string };
  serverId?: string;
  session?: {
    generation: number;
    roomId?: string;
    playerId?: string;
    token?: string;
    connected?: boolean;
  };
  view?: View;
  rooms?: RoomSummary[];
};
export interface Route {
  roomId?: string;
  watch: boolean;
}
export interface ClientState {
  view?: View;
  rooms: RoomSummary[];
  myRoomId?: string;
  connected: boolean;
  busy: boolean;
  error: string;
  notice: string;
  offset: number;
  status: Status;
  storageAvailable: boolean;
}
export class RoomClient {
  private state: ClientState = {
    rooms: [],
    connected: false,
    busy: false,
    error: "",
    notice: "",
    offset: 0,
    status: "connecting",
    storageAvailable: true,
  };
  private listeners = new Set<() => void>();
  private epoch = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private attempts = 0;
  private id?: SavedIdentity;
  private ephemeral = false;
  private alive = false;
  private route: Route;
  private explicitTakeover = false;
  private routeOverride?: Route;
  private departing = false;
  constructor(
    private socket: Socket,
    private store: IdentityStore,
    route: Route,
    private navigate: (r: Route) => void,
  ) {
    this.id = store.value;
    this.route = route;
  }
  snapshot = () => this.state;
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  private update(p: Partial<ClientState>) {
    this.state = { ...this.state, ...p };
    this.listeners.forEach((fn) => fn());
  }
  private save(id: SavedIdentity, required = false) {
    if (!this.ephemeral || required) {
      try {
        this.store.save(id);
      } catch (error) {
        if (required) throw error;
        this.ephemeral = true;
        this.update({ storageAvailable: false });
      }
    }
    this.id = id;
    this.update({ myRoomId: id.roomId });
  }
  private identity(seating = false) {
    if (seating && this.ephemeral && this.id) {
      this.store.save(this.id);
      this.ephemeral = false;
      this.update({ storageAvailable: true });
    }
    if (!this.id) {
      try {
        this.id = this.store.ensure();
      } catch (e) {
        this.update({ storageAvailable: false });
        if (seating) throw e;
        this.ephemeral = true;
        this.id = { browserId: secret(), secret: secret() };
      }
    } else if (seating) this.store.save(this.id);
    return this.id;
  }
  start() {
    this.alive = true;
    if (this.store.legacy && !this.id)
      this.update({ notice: "旧版单房间身份已失效，请创建或加入新房间。" });
    this.socket.on("connect", () => {
      this.epoch++;
      const takeover = this.explicitTakeover;
      this.explicitTakeover = false;
      if (this.state.status === "takenOver" && !takeover) {
        this.update({ connected: true });
        return;
      }
      this.update({ connected: true, status: "restoring", busy: true });
      void this.recover(takeover);
    });
    this.socket.on("disconnect", () => {
      this.epoch++;
      clearTimeout(this.timer);
      this.update({
        connected: false,
        busy: false,
        status: this.state.status === "takenOver" ? "takenOver" : "connecting",
        view: this.state.view
          ? {
              ...this.state.view,
              reveal: undefined,
              pending: undefined,
              swapFeedback: undefined,
            }
          : undefined,
      });
    });
    this.socket.on("connect_error", () =>
      this.update({ error: "连接不到服务器，正在重试…", status: "retrying" }),
    );
    this.socket.on("state", (v: View) => {
      if (
        this.state.status === "ready" &&
        this.state.view &&
        acceptsScope(this.state.view, v)
      )
        this.ingest(v);
    });
    this.socket.on(
      "rooms",
      (a: { serverId: string; generation: number; rooms: RoomSummary[] }) => {
        if (
          a.serverId === this.id?.serverId &&
          a.generation === this.id?.generation
        )
          this.update({ rooms: a.rooms });
      },
    );
    for (const event of ["takenOver", "removed", "roomClosed"])
      this.socket.on(
        event,
        (a: {
          serverId: string;
          roomId: string;
          generation: number;
          reason: string;
        }) => {
          if (
            a.serverId !== this.id?.serverId ||
            a.generation !== this.id?.generation
          )
            return;
          if (
            event !== "takenOver" &&
            a.roomId !== this.state.view?.roomId &&
            a.roomId !== this.id?.roomId
          )
            return;
          if (event === "takenOver") {
            this.epoch++;
            clearTimeout(this.timer);
            this.update({
              view: undefined,
              busy: false,
              status: "takenOver",
              error: "此身份已被另一页面接管。需要继续时，请主动接管。",
            });
            return;
          }
          const reserved = a.roomId === this.id?.roomId;
          const viewed = a.roomId === this.state.view?.roomId;
          if (reserved && this.id)
            this.save({
              ...this.id,
              roomId: undefined,
              playerId: undefined,
              token: undefined,
              pending: undefined,
            });
          const error =
            (
              {
                host: "房主已关闭房间",
                offline: "全部玩家离线已满 5 分钟，房间已关闭",
                empty: "最后一个席位已离开，房间已关闭",
                removed: "席位已撤销",
                left: "已离开房间",
              } as Record<string, string>
            )[a.reason] ?? "房间已关闭或席位已撤销";
          // Closing a reserved room must not erase an unrelated spectator view.
          if (viewed) {
            this.update({ view: undefined, error });
            this.setRoute({ watch: false });
          } else this.update({ error });
          if (!this.departing && viewed) {
            this.epoch++;
            clearTimeout(this.timer);
            this.update({ busy: false, status: "invalid" });
          }
        },
      );
    this.socket.connect();
  }
  stop() {
    this.alive = false;
    this.epoch++;
    clearTimeout(this.timer);
    this.socket.removeAllListeners();
    this.socket.disconnect();
  }
  private ingest(v: View) {
    this.update({ view: v, offset: v.serverNow - Date.now() });
  }
  private async request(
    event: string,
    data: Record<string, unknown>,
    epoch = this.epoch,
  ): Promise<Reply | undefined> {
    const op = startOperation(
      event === "command" ? (data.command as GameCommand).type : event,
      typeof data.requestId === "string" ? data.requestId : undefined,
    );
    mark(op, "send");
    const socketId = this.socket.id;
    try {
      const a: Reply = await this.socket
        .timeout(3500)
        .emitWithAck(event, { ...data, requestId: op.requestId });
      completeOperation(op, a.ok ? "ok" : (a.error?.code ?? "failed"));
      if (epoch !== this.epoch || socketId !== this.socket.id || !this.alive)
        return;
      return a;
    } catch (e) {
      completeOperation(op, "timeout");
      if (epoch !== this.epoch || !this.alive) return;
      throw e;
    }
  }
  private fail(a: Reply) {
    const code = a.error?.code;
    if (["STALE_SESSION", "TAKEN_OVER", "IN_USE"].includes(code ?? "")) {
      this.update({
        busy: false,
        status: "takenOver",
        view: undefined,
        error: "此页面身份已过期或被接管，请主动接管后继续。",
      });
      return;
    }
    if (
      ["ROOM_CLOSED", "SESSION", "REMOVED", "NOT_FOUND", "SERVER"].includes(
        code ?? "",
      )
    ) {
      if (this.id)
        this.save({
          ...this.id,
          roomId: undefined,
          playerId: undefined,
          token: undefined,
          ...a.session,
          pending: undefined,
        });
      this.update({
        busy: false,
        status: "invalid",
        view: undefined,
        error: a.error?.message ?? "房间或席位已失效，请返回列表。",
      });
      return;
    }
    if (code === "RATE") throw Error(a.error?.message);
    if (this.id?.pending) this.save({ ...this.id, pending: undefined });
    this.update({
      busy: false,
      status: "ready",
      error: a.error?.message ?? "操作失败",
    });
  }
  private later(error: unknown) {
    if (!this.alive || this.state.status === "takenOver") return;
    if (error instanceof Error && error.message.includes("存储")) {
      this.update({
        busy: false,
        status: "invalid",
        storageAvailable: false,
        error: error.message,
      });
      return;
    }
    this.update({
      busy: false,
      status: "retrying",
      error: error instanceof Error ? error.message : "恢复超时，正在重试…",
    });
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (this.socket.connected) void this.recover();
      else this.socket.connect();
    }, retryDelay(this.attempts++));
  }
  private accept(a: Reply) {
    if (a.session && this.id)
      this.save({
        ...this.id,
        serverId: a.serverId ?? this.id.serverId,
        roomId: undefined,
        playerId: undefined,
        token: undefined,
        ...a.session,
        pending: undefined,
      });
    if (a.rooms) this.update({ rooms: a.rooms });
    if (a.view) {
      this.ingest(a.view);
      if (a.view.role === "player") this.update({ notice: "" });
    }
    this.attempts = 0;
    this.departing = false;
    this.update({ busy: false, status: "ready", error: "" });
  }
  private async query(epoch: number) {
    const id = this.identity();
    return this.request(
      "session",
      {
        browserId: id.browserId,
        secret: id.secret,
        pendingRequestId: id.pending?.data.requestId,
      },
      epoch,
    );
  }
  private async recover(takeover = false) {
    const epoch = this.epoch;
    if (this.state.status === "takenOver" && !takeover) return;
    this.update({ busy: true, status: "restoring" });
    try {
      const before = this.identity();
      const a = await this.query(epoch);
      if (!a) return;
      if (!a.ok) {
        this.fail(a);
        return;
      }
      const changedServer = before.serverId && before.serverId !== a.serverId;
      if (changedServer && (before.roomId || before.pending)) {
        this.save({
          ...before,
          serverId: a.serverId,
          generation: a.session?.generation ?? 0,
          roomId: undefined,
          playerId: undefined,
          token: undefined,
          pending: undefined,
        });
        this.update({
          rooms: a.rooms ?? [],
          view: undefined,
          busy: false,
          status: "invalid",
          error: "服务器已重启，原牌局已失效。请返回列表创建或加入房间。",
        });
        return;
      }
      const delta = (a.session?.generation ?? 0) - (before.generation ?? 0);
      const pending = before.pending;
      const ownLostAck =
        !!a.receipt &&
        !!pending &&
        a.receipt?.requestId === pending.data.requestId &&
        a.receipt.event === pending.event &&
        a.receipt.generation === a.session?.generation;
      if (!takeover && before.serverId && delta !== 0 && !ownLostAck) {
        this.fail({
          ok: false,
          error: { code: "STALE_SESSION", message: "身份已被接管" },
        });
        return;
      }
      this.save({
        ...before,
        serverId: a.serverId,
        roomId: undefined,
        playerId: undefined,
        token: undefined,
        ...a.session,
        pending,
      });
      this.update({ rooms: a.rooms ?? [] });
      if (pending && !ownLostAck && !takeover) {
        await this.mutate(pending.event, pending.data, true, epoch);
        if (this.routeOverride && epoch === this.epoch) {
          const route = this.routeOverride;
          this.routeOverride = undefined;
          this.pop(route);
        }
        return;
      }
      let destination = this.routeOverride ?? this.route;
      if (ownLostAck && pending && !this.routeOverride) {
        destination =
          pending.event === "browse" || pending.event === "closeRoom"
            ? { watch: false }
            : {
                roomId:
                  a.receipt?.roomId ??
                  (pending.data.roomId as string | undefined),
                watch: pending.event === "watch",
              };
      }
      if (ownLostAck || takeover)
        this.save({ ...this.id!, pending: undefined });
      this.routeOverride = undefined;
      if (destination.watch && destination.roomId) {
        await this.mutate(
          "watch",
          { roomId: destination.roomId, takeover },
          false,
          epoch,
        );
        return;
      }
      if (destination.roomId) {
        if (this.id?.roomId === destination.roomId && this.id.token) {
          await this.mutate(
            "restore",
            { roomId: this.id.roomId, token: this.id.token, takeover: true },
            false,
            epoch,
          );
          return;
        }
        this.update({
          view: undefined,
          busy: false,
          status: "invalid",
          error: "没有此房间的有效席位，可返回列表或观战。",
        });
        return;
      }
      this.setRoute({ watch: false });
      if (ownLostAck || a.view || takeover) {
        await this.mutate("browse", { takeover }, false, epoch);
        return;
      }

      this.accept(a);
    } catch (e) {
      if (epoch === this.epoch) this.later(e);
    }
  }
  private setRoute(route: Route) {
    this.route = route;
    this.navigate(route);
  }
  private async mutate(
    event: string,
    data: Record<string, unknown>,
    replay = false,
    epoch = this.epoch,
  ) {
    const id = this.identity(event === "create" || event === "join");
    const envelope = replay
      ? data
      : {
          browserId: id.browserId,
          secret: id.secret,
          serverId: id.serverId,
          generation: id.generation,
          requestId: secret(),
          ...data,
        };
    this.save(
      { ...id, pending: { event, data: envelope } },
      event === "create" || event === "join",
    );
    const a = await this.request(event, envelope, epoch);
    if (!a) return;
    if (!a.ok) {
      this.fail(a);
      return;
    }
    this.accept(a);
    if (a.view && !this.routeOverride)
      this.setRoute({
        roomId: a.view.roomId,
        watch: a.view.role === "spectator",
      });
    else if (
      !this.routeOverride &&
      (event === "browse" || event === "closeRoom" || event === "watch")
    ) {
      this.setRoute({ watch: false });
      this.update({ view: undefined });
    }
  }
  private run(event: string, data: Record<string, unknown>) {
    if (
      this.state.busy ||
      !this.socket.connected ||
      this.state.status === "takenOver"
    )
      return;
    const epoch = ++this.epoch;
    clearTimeout(this.timer);
    this.departing = [
      "browse",
      "watch",
      "create",
      "join",
      "closeRoom",
    ].includes(event);
    this.update({
      busy: true,
      status: "restoring",
      error: "",
      view: undefined,
    });
    void this.mutate(event, data, false, epoch).catch((e) => {
      if (epoch === this.epoch) this.later(e);
    });
  }
  create = (name: string, roomName: string) =>
    this.run("create", { name, roomName });
  join = (roomId: string, name: string) => this.run("join", { roomId, name });
  watch = (roomId: string) => this.run("watch", { roomId });
  browse = () => this.run("browse", {});
  close = () => {
    const roomId = this.state.view?.roomId;
    if (roomId) this.run("closeRoom", { roomId, confirm: true });
  };
  resume = () => {
    if (this.id?.roomId && this.id.token)
      this.run("restore", {
        roomId: this.id.roomId,
        token: this.id.token,
        takeover: true,
      });
  };
  pop = (route: Route) => {
    clearTimeout(this.timer);
    this.routeOverride = route;
    this.route = route;
    this.epoch++;
    this.update({ view: undefined, busy: false });
    if (this.socket.connected) void this.recover();
  };
  reconnect = (takeover = false) => {
    clearTimeout(this.timer);
    this.epoch++;
    this.update({ view: undefined, busy: false });
    if (this.socket.connected) void this.recover(takeover);
    else {
      this.explicitTakeover = takeover;
      this.socket.connect();
    }
  };
  async send(command: GameCommand) {
    const v = this.state.view;
    if (
      !v ||
      v.role === "spectator" ||
      this.state.busy ||
      this.state.status !== "ready" ||
      !this.socket.connected
    )
      return false;
    const epoch = this.epoch;
    this.departing = command.type === "leave";
    this.update({ busy: true, error: "" });
    const scope = {
      roomId: v.roomId,
      serverId: v.serverId,
      generation: v.generation,
    };
    try {
      const a = await this.request(
        "command",
        { ...scope, version: v.version, command },
        epoch,
      );
      if (!a) return false;
      if (a.view && acceptsScope(v, a.view)) this.ingest(a.view);
      if (!a.ok) {
        this.update({ error: a.error?.message ?? "操作失败" });
        return false;
      }
      if (command.type === "leave") {
        this.save({
          ...this.id!,
          roomId: undefined,
          playerId: undefined,
          token: undefined,
        });
        this.setRoute({ watch: false });
        this.update({ view: undefined });
      }
      return true;
    } catch {
      if (epoch !== this.epoch) return false;
      this.update({
        status: "restoring",
        view: undefined,
        error: "未收到操作确认，正在同步牌局…",
      });
      try {
        const a = await this.request("sync", scope, epoch);
        if (a?.ok && a.view) {
          this.ingest(a.view);
          this.update({ status: "ready" });
        } else if (a) this.fail(a);
      } catch (e) {
        this.later(e);
      }
      return false;
    } finally {
      if (epoch === this.epoch) this.update({ busy: false });
    }
  }
}
export function browserClient() {
  let storage: Storage;
  try {
    storage = localStorage;
  } catch {
    storage = {
      getItem: () => null,
      setItem: () => {
        throw Error("blocked");
      },
      removeItem: () => {},
    } as unknown as Storage;
  }
  const route = () => {
    const p = new URLSearchParams(location.search);
    return {
      roomId: p.get("room") ?? undefined,
      watch: p.get("watch") === "1",
    };
  };
  const client = new RoomClient(
    io({ autoConnect: false }),
    new IdentityStore(storage),
    route(),
    (r) => {
      const url = new URL(location.href);
      url.searchParams.delete("room");
      url.searchParams.delete("watch");
      if (r.roomId) url.searchParams.set("room", r.roomId);
      if (r.watch) url.searchParams.set("watch", "1");
      if (url.href !== location.href) history.pushState(null, "", url);
    },
  );
  return { client, route };
}
