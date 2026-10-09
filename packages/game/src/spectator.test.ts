import { expect, it, vi } from "vitest";
import { GameEngine } from "./engine";

it("builds spectator snapshots directly from public state in every game phase", () => {
  const game = new GameEngine(
    [
      { id: "a", name: "A" },
      { id: "b", name: "B" },
    ],
    { now: 1000, random: () => 0.3 },
  );
  const playerView = vi.spyOn(game, "view").mockImplementation(() => {
    throw new Error("Do not serialize private views for spectators");
  });
  game.state.turnDeadline = 61000;
  game.state.players[0].hand[1].public = true;
  game.state.players[0].reveal = {
    cards: [{ playerId: "b", index: 2, card: { rank: 11, suit: "hearts" } }],
    deadline: 99999,
  };
  game.state.players[0].swapFeedback = {
    outcome: "swap-success",
    index: 2,
    deadline: 99999,
  };
  game.state.pending = {
    playerId: "a",
    card: { rank: 12, suit: "clubs" },
    source: "deck",
  };
  for (const phase of ["initial", "turn", "roundEnd", "gameOver"] as const) {
    game.state.phase = phase;
    const view = game.spectatorView(1000);
    expect(view).toMatchObject({
      role: "spectator",
      phase,
      deckCount: game.state.deck.length,
      discardTop: game.state.discard.at(-1),
    });
    for (const key of [
      "selfId",
      "initial",
      "reveal",
      "pending",
      "swapFeedback",
    ])
      expect(view).not.toHaveProperty(key);
    expect(view.players[0].hand[1].card).toEqual(
      game.state.players[0].hand[1].card,
    );
    if (phase === "initial" || phase === "turn")
      expect(view.players[0].hand[0]).not.toHaveProperty("card");
    else expect(view.players[0].hand.every((card) => card.card)).toBe(true);
  }
  expect(playerView).not.toHaveBeenCalled();
});
