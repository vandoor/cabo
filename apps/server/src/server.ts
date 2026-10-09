import express from "express";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { Server } from "socket.io";
import type { RoomOptions } from "./room.js";
import { RoomManager } from "./manager.js";
export function createRoomServer(options: RoomOptions = {}) {
  const app = express();
  const http = createServer(app);
  app.disable("x-powered-by");
  app.get("/health", (_req, res) => res.json({ ok: true }));
  app.use(express.static(resolve("apps/web/dist")));
  const io = new Server(http, { maxHttpBufferSize: 8192 });
  const manager = new RoomManager(io, options);
  const timer =
    options.tickInterval === 0
      ? undefined
      : setInterval(() => manager.tick(), options.tickInterval ?? 100);
  return {
    app,
    http,
    io,
    manager,
    get room() {
      const room = manager.rooms.values().next().value;
      if (!room) throw new Error("No rooms exist");
      return room;
    },
    close: async () => {
      if (timer) clearInterval(timer);
      await new Promise<void>((r) => io.close(() => r()));
    },
  };
}
