// Deterministic fixtures exist only in this test launcher, never in production.
import { createRoomServer } from "../../apps/server/src/server.js";
let clockOffset = 0;
const now = () => Date.now() + clockOffset;
const app = createRoomServer({ random: () => 0.31, tickInterval: 0, now });
let rejectPartial = false;
function installFault() {
  app.io.on("connection", (socket) =>
    socket.use((packet, next) => {
      if (packet[0] === "watch") socket.data.testWatching = true;
      if (packet[0] === "unwatch") socket.data.testWatching = false;
      if (
        rejectPartial &&
        packet[0] === "command" &&
        packet[1]?.command?.type === "initialSelect" &&
        packet[1].command.indices.length === 1
      ) {
        rejectPartial = false;
        packet[1].version -= 1;
      }
      next();
    }),
  );
}
installFault();
app.app.post("/__test/reject-partial", (_req, res) => {
  rejectPartial = true;
  res.json({ ok: true });
});
setInterval(() => app.manager.tick(), 100);
// Drop transports without revoking seats so clients exercise automatic reconnect.
app.app.post("/__test/drop-connections", (_req, res) => {
  for (const socket of app.io.sockets.sockets.values()) socket.conn.close();
  res.json({ ok: true });
});
app.app.post("/__test/drop-watchers", (_req, res) => {
  for (const socket of app.io.sockets.sockets.values())
    if (socket.data.testWatching) socket.conn.close();
  res.json({ ok: true });
});
app.app.post("/__test/reset", (_req, res) => {
  app.io.disconnectSockets(true);
  app.manager.rooms.clear();
  rejectPartial = false;
  clockOffset = 0;
  res.json({ ok: true });
});
app.app.post("/__test/skill", (req, res) => {
  const engine = app.room.engine;
  if (!engine) return res.sendStatus(409);
  const s = engine.state;
  // Move a real 7 to the top without duplicating any card.
  const index = s.deck.findIndex((c) => c.rank === Number(req.query.rank ?? 7));
  if (index >= 0)
    [s.deck[index], s.deck[s.deck.length - 1]] = [
      s.deck[s.deck.length - 1],
      s.deck[index],
    ];
  if (req.query.last === "true")
    s.discard.push(...s.deck.splice(0, s.deck.length - 1));
  res.json({ ok: true });
});
app.app.post("/__test/final", (_req, res) => {
  if (!app.room.engine) return res.sendStatus(409);
  app.room.engine.state.players.forEach((p) => (p.total = 95));
  res.json({ ok: true });
});
app.app.post("/__test/merge", (_req, res) => {
  const s = app.room.engine?.state;
  if (!s) return res.sendStatus(409);
  const hand = s.players[s.turnIndex].hand;
  const pair = s.deck.find(
    (card) => s.deck.filter((c) => c.rank === card.rank).length >= 2,
  );
  if (!pair) return res.sendStatus(409);
  // Preserve the real deck: exchange two matching cards into positions 2 and 4.
  for (const index of [1, 3]) {
    const source = s.deck.findIndex((card) => card.rank === pair.rank);
    [hand[index].card, s.deck[source]] = [s.deck[source], hand[index].card];
  }
  res.json({ ok: true });
});
// Arrange an unambiguously failed caller using existing cards only.
app.app.post("/__test/cabo-failed", (_req, res) => {
  const s = app.room.engine?.state;
  if (!s || s.phase !== "turn" || s.pending) return res.sendStatus(409);
  const pool = [
    ...s.deck,
    ...s.players.flatMap((p) => p.hand.map((h) => h.card)),
  ].sort((a, b) => a.rank - b.rank);
  for (const [i, player] of s.players.entries()) {
    if (i === s.turnIndex) continue;
    for (const hand of player.hand) hand.card = pool.shift()!;
  }
  for (const hand of s.players[s.turnIndex].hand) hand.card = pool.pop()!;
  // Avoid QQKK, which correctly overrides a failed CABO call.
  const caller = s.players[s.turnIndex];
  if (
    caller.hand.length === 4 &&
    caller.hand.filter((h) => h.card.rank === 12).length === 2 &&
    caller.hand.filter((h) => h.card.rank === 13).length === 2
  ) {
    const index = pool.findIndex((c) => c.rank === 11);
    [caller.hand[0].card, pool[index]] = [pool[index], caller.hand[0].card];
  }
  s.deck = pool;
  res.json({ ok: true });
});
app.http.listen(3100, "127.0.0.1");
app.app.post("/__test/finish-offline", (_req, res) => {
  const room = app.room;
  for (let i = 0; i < 4 && room.engine?.state.phase === "turn"; i++) {
    clockOffset += Math.max(0, room.engine.state.turnDeadline! - now());
    app.manager.tick(now());
  }
  res.json({ ok: true });
});
