// Deterministic fixtures exist only in this test launcher, never in production.
import { Room } from "../../apps/server/src/room.js";
import { createRoomServer } from "../../apps/server/src/server.js";
const app = createRoomServer({ random: () => 0.31, tickInterval: 0 });
let rejectPartial = false;
function installFault() {
  app.io.on("connection", (socket) =>
    socket.use((packet, next) => {
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
setInterval(() => app.room.tick(), 100);
app.app.post("/__test/reset", (_req, res) => {
  app.io.disconnectSockets(true);
  app.io.removeAllListeners("connection");
  app.room = new Room(app.io, { random: () => 0.31 });
  rejectPartial = false;
  installFault();
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
app.http.listen(3100, "127.0.0.1");
