import express from "express";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { Server } from "socket.io";
import { Room, type RoomOptions } from "./room.js";
export function createRoomServer(options: RoomOptions = {}) {
  const app = express();
  const http = createServer(app);
  app.disable("x-powered-by");
  app.get("/health", (_req, res) => res.json({ ok: true }));
  app.use(express.static(resolve("apps/web/dist")));
  const io = new Server(http, { maxHttpBufferSize: 8192 });
  const room = new Room(io, options);
  const timer =
    options.tickInterval === 0
      ? undefined
      : setInterval(() => room.tick(), options.tickInterval ?? 100);
  return {
    app,
    http,
    io,
    room,
    close: async () => {
      if (timer) clearInterval(timer);
      await new Promise<void>((r) => io.close(() => r()));
    },
  };
}
