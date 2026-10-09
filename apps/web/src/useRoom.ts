import { useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import type {
  Ack,
  GameCommand,
  RoomView,
} from "../../../packages/game/src/types";
import { startOperation, completeOperation, mark } from "./timing";
const key = "cabo-session";
function savedToken() {
  try {
    return localStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}
function save(value?: string) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    /* in-memory works */
  }
}
const watching = () =>
  new URLSearchParams(location.search).get("watch") === "1";
function watchLocation(active: boolean) {
  const url = new URL(location.href);
  if (active) url.searchParams.set("watch", "1");
  else url.searchParams.delete("watch");
  history.replaceState(null, "", url);
}
type Reply = Omit<Ack, "view"> & { view?: RoomView; token?: string };
export function useRoom() {
  const socket = useRef<Socket | undefined>(undefined);
  const current = useRef<RoomView | undefined>(undefined);
  const session = useRef(savedToken());
  const spectator = useRef(watching());
  const inFlight = useRef(false);
  const [view, setView] = useState<RoomView>();
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [offset, setOffset] = useState(0);
  function ingest(v?: RoomView) {
    if (v && (!current.current || v.version >= current.current.version)) {
      current.current = v;
      setView(v);
      setOffset(v.serverNow - Date.now());
    }
  }
  async function request(
    event: string,
    data: object,
    retry = false,
    step = event,
  ) {
    const op = startOperation(step);
    const envelope = { ...data, requestId: op.requestId };
    const s = socket.current!;
    try {
      mark(op, "send");
      let a: Reply;
      try {
        a = await s.timeout(3500).emitWithAck(event, envelope);
      } catch (e) {
        if (!retry || !s.connected) throw e;
        mark(op, "retry", "timeout");
        mark(op, "send");
        a = await s.timeout(3500).emitWithAck(event, envelope);
      }
      completeOperation(op, a.ok ? "ok" : (a.error?.code ?? "failed"));
      ingest(a.view);
      if (!a.ok) setError(a.error?.message ?? "操作失败");
      return a;
    } catch (e) {
      completeOperation(op, "timeout");
      throw e;
    }
  }
  useEffect(() => {
    const s = io({ autoConnect: false });
    socket.current = s;
    s.on("state", ingest);
    s.on("connect", () => {
      setConnected(true);
      setError("");
      if (spectator.current || session.current) {
        setBusy(true);
        inFlight.current = true;
        void request(
          spectator.current ? "watch" : "join",
          spectator.current ? {} : { token: session.current },
          false,
          spectator.current ? "watch" : "restore",
        )
          .then((a) => {
            if (!a.ok && !spectator.current) {
              session.current = undefined;
              save();
              current.current = undefined;
              setView(undefined);
            }
          })
          .catch(() => setError("恢复连接超时，请重新连接"))
          .finally(() => {
            setBusy(false);
            inFlight.current = false;
          });
      }
    });
    s.on("disconnect", () => {
      setConnected(false);
      setBusy(false);
      inFlight.current = false;
    });
    s.on("connect_error", () => setError("连接不到牌桌，正在重试…"));
    s.on("takenOver", () =>
      setError("此身份已在另一个页面打开；关闭本页即可。"),
    );
    s.on("removed", () => {
      session.current = undefined;
      save();
      current.current = undefined;
      setView(undefined);
      setError("已离开房间");
    });
    s.connect();
    return () => {
      s.removeAllListeners();
      s.disconnect();
    };
  }, []);
  async function enter(event: "join" | "watch", name?: string) {
    if (inFlight.current) return;
    if (!socket.current?.connected) {
      socket.current?.connect();
      setError("正在连接，请连接成功后再入座或观战");
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      const a = await request(event, event === "join" ? { name } : {});
      if (a.ok) {
        if (event === "join") {
          session.current = a.token;
          save(a.token);
        } else {
          spectator.current = true;
          watchLocation(true);
        }
      }
    } catch {
      setError("未收到确认，请重试");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  async function unwatch() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      if (socket.current?.connected) {
        const a = await request("unwatch", {});
        if (!a.ok) return;
      }
      spectator.current = false;
      watchLocation(false);
      current.current = undefined;
      setView(undefined);
      // Start a fresh guest connection after leaving the read-only socket.
      // Keep the saved player identity untouched; only a reload may restore it.
      session.current = undefined;
      socket.current?.disconnect();
      socket.current?.connect();
    } catch {
      setError("退出观战未收到确认，请重试");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  async function send(command: GameCommand) {
    const s = socket.current,
      v = current.current;
    if (!s?.connected || !v || v.role === "spectator" || inFlight.current)
      return false;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      const a = await request(
        "command",
        { version: v.version, command },
        true,
        command.type,
      );
      if (a.ok && command.type === "leave") {
        session.current = undefined;
        save();
        current.current = undefined;
        setView(undefined);
      }
      return a.ok;
    } catch {
      setError("未收到操作确认；正在同步牌局");
      if (s.connected)
        void request("sync", {}).catch(() => setError("同步失败，请重新连接"));
      return false;
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  return {
    view,
    connected,
    busy,
    error,
    offset,
    send,
    join: (name: string) => enter("join", name),
    watch: () => enter("watch"),
    unwatch,
    reconnect: () => {
      socket.current?.disconnect();
      socket.current?.connect();
    },
  };
}
