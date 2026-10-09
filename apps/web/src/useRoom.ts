import { useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import type {
  Ack,
  GameCommand,
  PlayerView,
} from "../../../packages/game/src/types";
const key = "cabo-session";
function token() {
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
    /* In-memory session still works. */
  }
}
export function useRoom() {
  const socket = useRef<Socket | undefined>(undefined),
    current = useRef<PlayerView | undefined>(undefined),
    session = useRef(token());
  const [view, setView] = useState<PlayerView>();
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [offset, setOffset] = useState(0);
  const ingest = (v?: PlayerView) => {
    if (v && (!current.current || v.version >= current.current.version)) {
      current.current = v;
      setView(v);
      setOffset(v.serverNow - Date.now());
    }
  };
  useEffect(() => {
    const s = io({ autoConnect: false });
    socket.current = s;
    s.on("state", ingest);
    s.on("connect", () => {
      setConnected(true);
      setError("");
      if (session.current)
        s.timeout(5000).emit(
          "join",
          { token: session.current },
          (err: Error | null, a: Ack) => {
            if (err) {
              setError("恢复身份超时，请重新连接");
              return;
            }
            if (a.ok) ingest(a.view);
            else {
              session.current = undefined;
              save();
              current.current = undefined;
              setView(undefined);
              setError(a.error?.message ?? "身份已失效");
            }
          },
        );
    });
    s.on("disconnect", () => {
      setConnected(false);
      setBusy(false);
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
  async function join(name: string) {
    if (busy) return;
    setBusy(true);
    setError("");
    const s = socket.current!;
    if (!s.connected) {
      s.connect();
      setBusy(false);
      setError("正在连接，请连接成功后再入座");
      return;
    }
    try {
      const a = (await s.timeout(5000).emitWithAck("join", { name })) as Ack & {
        token?: string;
      };
      if (a.ok) {
        session.current = a.token;
        save(a.token);
        ingest(a.view);
      } else setError(a.error?.message ?? "入座失败");
    } catch {
      setError("入座超时，请重试");
    } finally {
      setBusy(false);
    }
  }
  async function send(command: GameCommand) {
    const s = socket.current,
      v = current.current;
    if (!s?.connected || !v || busy) return false;
    setBusy(true);
    setError("");
    const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
    const envelope = { requestId, version: v.version, command };
    try {
      let a: Ack;
      try {
        a = await s.timeout(3500).emitWithAck("command", envelope);
      } catch {
        if (!s.connected) throw new Error();
        a = await s.timeout(3500).emitWithAck("command", envelope);
      }
      ingest(a.view);
      if (!a.ok) setError(a.error?.message ?? "操作失败");
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
        s.timeout(3000).emit("sync", (_e: unknown, a: Ack) => ingest(a?.view));
      return false;
    } finally {
      setBusy(false);
    }
  }
  return {
    view,
    connected,
    busy,
    error,
    join,
    send,
    offset,
    reconnect: () => socket.current?.connect(),
  };
}
