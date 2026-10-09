import { describe, expect, it } from "vitest";
import { GameEngine, createDeck, scoreHand } from "./engine";
import type { CardFace } from "./types";
const face = (rank: number, suit: CardFace["suit"] = "spades"): CardFace => ({
  rank,
  suit,
});
const make = (n = 2) =>
  new GameEngine(
    Array.from({ length: n }, (_, i) => ({ id: String(i), name: `P${i}` })),
    { random: () => 0.25, now: 0 },
  );
const active = (n = 2) => {
  const g = make(n);
  for (const p of g.state.players) {
    g.apply(p.id, { type: "initialSelect", indices: [0, 1] }, 1);
    g.apply(p.id, { type: "closeReveal" }, 2);
  }
  return g;
};
const current = (g: GameEngine) => g.state.players[g.state.turnIndex].id;
const setHand = (g: GameEngine, id: string, ranks: number[]) => {
  g.state.players.find((p) => p.id === id)!.hand = ranks.map((rank) => ({
    card: face(rank),
    public: false,
  }));
};
const finish = (g: GameEngine, now = 100) => {
  g.state.deck = [];
  g.apply(current(g), { type: "draw", source: "discard" }, now);
  g.apply(current(g), { type: "discard" }, now + 1);
};

describe("deck and private initial reveal", () => {
  it("has 52 unique cards with only two kings and zero-valued jokers", () => {
    const d = createDeck();
    expect(d).toHaveLength(52);
    expect(new Set(d.map((c) => `${c.rank}:${c.suit}`)).size).toBe(52);
    expect(d.filter((c) => c.rank === 13)).toHaveLength(2);
    expect(
      scoreHand([face(0, "joker-black"), face(1), face(12), face(13)]),
    ).toBe(26);
  });
  it("deals four hidden cards and conserves every card", () => {
    const g = make(4);
    expect(
      g.state.deck.length +
        g.state.discard.length +
        g.state.players.flatMap((p) => p.hand).length,
    ).toBe(52);
    expect(
      g.view("0", 0).players.every((p) => p.hand.every((c) => !c.card)),
    ).toBe(true);
  });
  it("requires two unique initial indices and keeps reveal private until expiry", () => {
    const g = make();
    expect(() =>
      g.apply("0", { type: "initialSelect", indices: [0, 0] }, 1),
    ).toThrow();
    g.apply("0", { type: "initialSelect", indices: [1, 3] }, 1);
    expect(g.view("0", 1).reveal?.cards.map((c) => c.index)).toEqual([1, 3]);
    expect(g.view("1", 1).reveal).toBeUndefined();
    g.tick(10001);
    expect(g.view("0", 10001).reveal).toBeUndefined();
  });
  it("auto-selects at 30s and starts turn after 10s reveal", () => {
    const g = make();
    g.tick(30000);
    expect(g.view("0", 30000).reveal?.cards.map((c) => c.index)).toEqual([
      0, 1,
    ]);
    g.tick(40000);
    expect(g.state.phase).toBe("turn");
    expect(g.state.turnDeadline).toBe(100000);
  });
});
describe("turn and swapping", () => {
  it("hides pending cards from everyone except actor and fixes turn deadline", () => {
    const g = active();
    const id = current(g);
    const deadline = g.state.turnDeadline;
    g.apply(id, { type: "draw", source: "deck" }, 100);
    expect(g.view(id, 100).pending).toBeDefined();
    expect(g.view(id === "0" ? "1" : "0", 100).pending).toBeUndefined();
    expect(g.state.turnDeadline).toBe(deadline);
    expect(() => g.apply(id, { type: "cabo" }, 101)).toThrow();
  });
  it("successful multi swap discards in old index order and compacts at minimum", () => {
    const g = active();
    const id = current(g);
    setHand(g, id, [4, 8, 4, 9]);
    g.state.deck.push(face(2));
    g.apply(id, { type: "draw", source: "deck" }, 10);
    g.apply(id, { type: "swap", indices: [2, 0] }, 11);
    expect(
      g.state.players.find((p) => p.id === id)!.hand.map((c) => c.card.rank),
    ).toEqual([2, 8, 9]);
    expect(g.state.discard.slice(-2).map((c) => c.rank)).toEqual([4, 4]);
  });
  it("failed multi swap leaves selected public and appends incoming hidden", () => {
    const g = active();
    const id = current(g);
    setHand(g, id, [4, 8, 5, 9]);
    g.state.deck.push(face(2));
    g.apply(id, { type: "draw", source: "deck" }, 10);
    g.apply(id, { type: "swap", indices: [2, 0] }, 11);
    const hand = g.state.players.find((p) => p.id === id)!.hand;
    expect(hand.map((c) => c.card.rank)).toEqual([4, 8, 5, 9, 2]);
    expect(hand.map((c) => c.public)).toEqual([
      true,
      false,
      true,
      false,
      false,
    ]);
  });
  it("rejects invalid swap and preserves pending until valid discard", () => {
    const g = active();
    const id = current(g);
    g.apply(id, { type: "draw", source: "deck" }, 10);
    for (const indices of [[], [0, 0], [-1], [4], [0.5]])
      expect(() => g.apply(id, { type: "swap", indices }, 11)).toThrow();
    expect(g.state.pending).toBeDefined();
    g.apply(id, { type: "discard" }, 12);
    expect(g.state.pending).toBeUndefined();
  });
  it("timeout draws then discards, or discards pending, with conservation", () => {
    const g = active();
    const count = () =>
      g.state.deck.length +
      g.state.discard.length +
      g.state.players.flatMap((p) => p.hand).length +
      (g.state.pending ? 1 : 0);
    const start = current(g);
    g.tick(g.state.turnDeadline!);
    expect(current(g)).not.toBe(start);
    expect(count()).toBe(52);
    g.apply(
      current(g),
      { type: "draw", source: "deck" },
      g.state.turnDeadline! - 1,
    );
    g.tick(g.state.turnDeadline!);
    expect(count()).toBe(52);
  });
});
describe("private swap feedback", () => {
  it.each([
    { indices: [2], ranks: [4, 8, 4, 9], outcome: "swap-success", index: 2 },
    {
      indices: [3, 1],
      ranks: [4, 8, 9, 8],
      outcome: "merge-success",
      index: 1,
    },
    { indices: [2, 0], ranks: [4, 8, 5, 9], outcome: "merge-failed", index: 4 },
  ])(
    "reports $outcome at the resulting slot",
    ({ indices, ranks, outcome, index }) => {
      const g = active();
      const id = current(g);
      setHand(g, id, ranks);
      g.apply(id, { type: "draw", source: "deck" }, 10);
      g.apply(id, { type: "swap", indices }, 11);
      expect(g.view(id, 11).swapFeedback).toEqual({
        outcome,
        index,
        deadline: 5011,
      });
      expect(
        g.view(id, 11).players.find((p) => p.id === id)!.hand[index].card,
      ).toBeUndefined();
    },
  );

  it("keeps feedback private, cloned and on its original deadline across updates", () => {
    const g = active();
    const id = current(g);
    g.apply(id, { type: "draw", source: "deck" }, 10);
    g.apply(id, { type: "swap", indices: [1] }, 11);
    const mine = g.view(id, 12);
    expect(mine.swapFeedback).toEqual({
      outcome: "swap-success",
      index: 1,
      deadline: 5011,
    });
    mine.swapFeedback!.index = 3;
    const other = current(g);
    g.apply(other, { type: "draw", source: "deck" }, 20);
    expect(g.view(other, 20).swapFeedback).toBeUndefined();
    expect(JSON.stringify(g.view(other, 20))).not.toContain("swapFeedback");
    expect(g.view(id, 5010).swapFeedback).toEqual({
      outcome: "swap-success",
      index: 1,
      deadline: 5011,
    });
    expect(g.view(id, 5011).swapFeedback).toBeUndefined();
  });

  it("replaces previous feedback after another own swap", () => {
    const g = active();
    const id = current(g);
    g.apply(id, { type: "draw", source: "deck" }, 10);
    g.apply(id, { type: "swap", indices: [0] }, 11);
    g.apply(current(g), { type: "draw", source: "deck" }, 12);
    g.apply(current(g), { type: "discard" }, 13);
    g.apply(id, { type: "draw", source: "deck" }, 14);
    g.apply(id, { type: "swap", indices: [2] }, 15);
    expect(g.view(id, 15).swapFeedback).toEqual({
      outcome: "swap-success",
      index: 2,
      deadline: 5015,
    });
  });

  it("invalid commands neither create nor extend feedback", () => {
    const g = active();
    const id = current(g);
    expect(() => g.apply(id, { type: "swap", indices: [0] }, 10)).toThrow();
    expect(g.view(id, 10).swapFeedback).toBeUndefined();
    g.apply(id, { type: "draw", source: "deck" }, 11);
    expect(() => g.apply(id, { type: "swap", indices: [4] }, 12)).toThrow();
    expect(g.view(id, 12).swapFeedback).toBeUndefined();
    g.apply(id, { type: "swap", indices: [0] }, 13);
    expect(() => g.apply(id, { type: "swap", indices: [1] }, 14)).toThrow();
    expect(g.view(id, 14).swapFeedback).toEqual({
      outcome: "swap-success",
      index: 0,
      deadline: 5013,
    });
  });

  it.each([11, 12])(
    "rank %i clears only feedback on a moved slot for both players",
    (rank) => {
      for (const index of [0, 1, 2]) {
        const g = active();
        const actor = current(g);
        g.apply(actor, { type: "draw", source: "deck" }, 10);
        g.apply(actor, { type: "swap", indices: [0] }, 11);
        const target = current(g);
        g.apply(target, { type: "draw", source: "deck" }, 12);
        g.apply(target, { type: "swap", indices: [1] }, 13);
        g.state.deck.push(face(rank));
        g.apply(actor, { type: "draw", source: "deck" }, 14);
        g.apply(
          actor,
          {
            type: "exchange",
            first: { playerId: actor, index },
            second: { playerId: target, index },
          },
          15,
        );
        expect(g.view(actor, 15).swapFeedback).toEqual(
          index === 0
            ? undefined
            : { outcome: "swap-success", index: 0, deadline: 5011 },
        );
        expect(g.view(target, 15).swapFeedback).toEqual(
          index === 1
            ? undefined
            : { outcome: "swap-success", index: 1, deadline: 5013 },
        );
      }
    },
  );

  it("clears feedback at settlement and the following round", () => {
    const g = active();
    const id = current(g);
    g.apply(id, { type: "draw", source: "deck" }, 10);
    g.apply(id, { type: "swap", indices: [0] }, 11);
    expect(g.view(id, 11).swapFeedback).toBeDefined();
    finish(g, 12);
    expect(g.view(id, 13).swapFeedback).toBeUndefined();
    expect(g.state.players.every((p) => p.swapFeedback === undefined)).toBe(
      true,
    );
    // Seed stale state to verify a new round itself also clears feedback.
    g.state.players[0].swapFeedback = {
      outcome: "swap-success",
      index: 0,
      deadline: 20000,
    };
    g.apply(id, { type: "nextRound" }, 8013);
    expect(g.state.players.every((p) => p.swapFeedback === undefined)).toBe(
      true,
    );
    expect(g.view(id, 8013).swapFeedback).toBeUndefined();
  });

  it("does not expose feedback when the swap itself ends the round", () => {
    const g = active();
    const id = current(g);
    g.state.deck = [face(3)];
    g.apply(id, { type: "draw", source: "deck" }, 10);
    g.apply(id, { type: "swap", indices: [0] }, 11);
    expect(g.state.phase).toBe("roundEnd");
    expect(g.view(id, 11).swapFeedback).toBeUndefined();
    expect(g.state.players.every((p) => p.swapFeedback === undefined)).toBe(
      true,
    );
  });
});

describe("skills", () => {
  it("7/8 reveal self privately and lock turn until close; discard-source cannot use skill", () => {
    const g = active();
    const id = current(g);
    g.state.deck.push(face(7));
    g.apply(id, { type: "draw", source: "deck" }, 10);
    g.apply(id, { type: "skill", targetId: id, index: 0 }, 11);
    expect(g.view(id, 11).reveal?.deadline).toBe(5011);
    expect(current(g)).toBe(id);
    expect(() => g.apply(id, { type: "draw", source: "deck" }, 12)).toThrow();
    g.apply(id, { type: "closeReveal" }, 12);
    expect(current(g)).not.toBe(id);
    g.state.discard.push(face(7));
    g.apply(current(g), { type: "draw", source: "discard" }, 13);
    expect(() =>
      g.apply(
        current(g),
        { type: "skill", targetId: current(g), index: 0 },
        14,
      ),
    ).toThrow();
  });
  it("9/10 reveal only opponents and expiry is bounded by turn deadline", () => {
    const g = active();
    const id = current(g),
      other = id === "0" ? "1" : "0";
    g.state.deck.push(face(9));
    g.apply(id, { type: "draw", source: "deck" }, g.state.turnDeadline! - 2);
    expect(() =>
      g.apply(
        id,
        { type: "skill", targetId: id, index: 0 },
        g.state.turnDeadline! - 1,
      ),
    ).toThrow();
    g.apply(
      id,
      { type: "skill", targetId: other, index: 0 },
      g.state.turnDeadline! - 1,
    );
    expect(g.view(id, g.state.turnDeadline! - 1).reveal?.deadline).toBe(
      g.state.turnDeadline,
    );
    g.tick(g.state.turnDeadline!);
    expect(g.view(id, g.state.turnDeadline!).reveal).toBeUndefined();
  });
  it("J/Q exchange preserves public status without revealing hidden cards", () => {
    const g = active();
    const id = current(g),
      other = id === "0" ? "1" : "0";
    setHand(g, id, [2]);
    setHand(g, other, [6]);
    g.state.players.find((p) => p.id === other)!.hand[0].public = true;
    g.state.deck.push(face(11));
    g.apply(id, { type: "draw", source: "deck" }, 10);
    g.apply(
      id,
      {
        type: "exchange",
        first: { playerId: id, index: 0 },
        second: { playerId: other, index: 0 },
      },
      11,
    );
    expect(g.state.players.find((p) => p.id === id)!.hand[0]).toEqual({
      card: face(6),
      public: true,
    });
    expect(g.state.players.find((p) => p.id === other)!.hand[0]).toEqual({
      card: face(2),
      public: false,
    });
    expect(g.view(id, 11).reveal).toBeUndefined();
  });
});
describe("rounds and scoring", () => {
  it("CABO consumes turn and gives each other player one final turn, tied caller scores zero", () => {
    const g = active(3);
    const id = current(g);
    for (const p of g.state.players) setHand(g, p.id, [5]);
    g.apply(id, { type: "cabo" }, 10);
    expect(g.state.remainingFinalTurns).toBe(2);
    expect(() => g.apply(current(g), { type: "cabo" }, 11)).toThrow();
    for (let i = 0; i < 2; i++) {
      g.apply(current(g), { type: "draw", source: "discard" }, 12 + i * 2);
      g.apply(current(g), { type: "discard" }, 13 + i * 2);
    }
    expect(g.state.phase).toBe("roundEnd");
    expect(g.state.results?.find((r) => r.playerId === id)?.round).toBe(0);
  });
  it("adds ten to unsuccessful caller score (23 becomes 33)", () => {
    const g = active();
    const id = current(g);
    setHand(g, id, [11, 12]);
    setHand(g, id === "0" ? "1" : "0", [5]);
    g.apply(id, { type: "cabo" }, 10);
    g.apply(current(g), { type: "draw", source: "discard" }, 11);
    g.apply(current(g), { type: "discard" }, 12);
    expect(g.state.results?.find((r) => r.playerId === id)?.round).toBe(33);
  });
  it("last draw completes action before settling even during CABO", () => {
    const g = active();
    g.apply(current(g), { type: "cabo" }, 10);
    g.state.deck = [face(3)];
    const id = current(g);
    g.apply(id, { type: "draw", source: "deck" }, 11);
    expect(g.state.phase).toBe("turn");
    g.apply(id, { type: "swap", indices: [0] }, 12);
    expect(g.state.phase).toBe("roundEnd");
  });
  it("exact QQKK overrides CABO while longer hands do not", () => {
    const g = active();
    const id = current(g),
      other = id === "0" ? "1" : "0";
    setHand(g, id, [12, 12, 13, 13]);
    setHand(g, other, [1]);
    g.apply(other === current(g) ? other : id, { type: "cabo" }, 10);
    g.apply(current(g), { type: "draw", source: "discard" }, 11);
    g.apply(current(g), { type: "discard" }, 12);
    expect(g.state.results?.find((r) => r.playerId === id)?.round).toBe(0);
    expect(g.state.results?.find((r) => r.playerId === other)?.round).toBe(50);
    const h = active();
    setHand(h, "0", [12, 12, 13, 13, 0]);
    finish(h);
    expect(h.state.results?.find((r) => r.playerId === "0")?.reason).toBe(
      "normal",
    );
  });
  it("first exact100 resets50, next exact100 stays100, above100 ends with tied minimum winners", () => {
    const g = active(3);
    for (const p of g.state.players) {
      setHand(g, p.id, [5]);
      p.total = 95;
    }
    finish(g);
    expect(g.state.players.every((p) => p.total === 50 && p.resetUsed)).toBe(
      true,
    );
    g.apply("0", { type: "nextRound" }, 8101);
    g.tick(48101);
    for (const p of g.state.players) {
      setHand(g, p.id, [5]);
      p.total = 95;
    }
    finish(g, 48102);
    expect(g.state.players.every((p) => p.total === 100)).toBe(true);
    g.apply("0", { type: "nextRound" }, 56103);
    g.tick(96103);
    for (const p of g.state.players) {
      setHand(g, p.id, [1]);
      p.total = p.id === "0" ? 100 : 40;
    }
    finish(g, 96104);
    expect(g.state.phase).toBe("gameOver");
    expect(g.state.winners).toEqual(["1", "2"]);
  });
  it("rounds rotate starter, enforce8s cooldown, and restart clears totals/flags", () => {
    const g = active();
    const starter = g.state.starterIndex;
    finish(g);
    expect(() => g.apply("0", { type: "nextRound" }, 8100)).toThrow();
    g.apply("0", { type: "nextRound" }, 8101);
    expect(g.state.starterIndex).toBe((starter + 1) % 2);
    g.state.players[0].total = 50;
    g.state.players[0].resetUsed = true;
    expect(() => g.apply("0", { type: "restart" }, 9000)).toThrow();
    g.state.phase = "gameOver";
    g.state.nextRoundAt = 17000;
    expect(() => g.apply("0", { type: "restart" }, 16999)).toThrow();
    g.apply("0", { type: "restart" }, 17000);
    expect(g.state.round).toBe(1);
    expect(g.state.players[0].total).toBe(0);
    expect(g.state.players[0].resetUsed).toBe(false);
  });
});

describe("security and complete round invariants", () => {
  it("does not expose or alias hidden card data through views or logs", () => {
    const g = active();
    const id = current(g);
    g.apply(id, { type: "draw", source: "deck" }, 10);
    const other = g.view(id === "0" ? "1" : "0", 10);
    expect(JSON.stringify(other)).not.toContain("joker-black");
    expect(other.pending).toBeUndefined();
    const mine = g.view(id, 10);
    mine.pending!.card.rank = 99;
    mine.players[0].total = 999;
    mine.logs[0].text = "modified";
    expect(g.state.pending!.card.rank).not.toBe(99);
    expect(g.state.players[0].total).toBe(0);
    expect(g.state.logs[0].text).not.toBe("modified");
  });
  it("shows every hand at settlement and clones result cards", () => {
    const g = active();
    finish(g);
    const view = g.view("0", 101);
    expect(view.players.every((p) => p.hand.every((h) => h.card))).toBe(true);
    view.results![0].hand[0].rank = 99;
    expect(g.state.results![0].hand[0].rank).not.toBe(99);
  });
  it("keeps the last-card peek open until private reveal closes", () => {
    const g = active();
    const id = current(g);
    g.state.deck = [face(8)];
    g.apply(id, { type: "draw", source: "deck" }, 10);
    g.apply(id, { type: "skill", targetId: id, index: 0 }, 11);
    expect(g.state.phase).toBe("turn");
    expect(g.view(id, 12).reveal).toBeDefined();
    g.tick(5011);
    expect(g.state.phase).toBe("roundEnd");
    expect(g.view(id, 5011).reveal).toBeUndefined();
  });
  it("orders discarded equal-rank cards by old positions regardless of selection order", () => {
    const g = active();
    const id = current(g);
    const p = g.state.players.find((p) => p.id === id)!;
    p.hand = [
      { card: face(4, "hearts"), public: false },
      { card: face(5), public: false },
      { card: face(4, "clubs"), public: false },
    ];
    g.apply(id, { type: "draw", source: "deck" }, 10);
    g.apply(id, { type: "swap", indices: [2, 0] }, 11);
    expect(g.state.discard.slice(-2)).toEqual([
      face(4, "hearts"),
      face(4, "clubs"),
    ]);
    expect(g.view(id, 11).discardTop).toEqual(face(4, "clubs"));
  });
  it("matches differently colored jokers by value and accepts hands larger than four", () => {
    const g = active();
    const id = current(g);
    const p = g.state.players.find((p) => p.id === id)!;
    p.hand = [
      { card: face(0, "joker-black"), public: true },
      { card: face(0, "joker-red"), public: false },
      ...Array.from({ length: 8 }, () => ({ card: face(5), public: false })),
    ];
    g.apply(id, { type: "draw", source: "deck" }, 10);
    g.apply(id, { type: "swap", indices: [1, 0] }, 11);
    expect(p.hand).toHaveLength(9);
    expect(p.hand[0].public).toBe(false);
  });
  it.each([2, 3, 4])(
    "conserves all 52 unique cards through full %i-player timeout round",
    (n) => {
      const g = make(n);
      g.tick(40000);
      let loops = 0;
      while (g.state.phase === "turn") {
        g.tick(g.state.turnDeadline!);
        const all = [
          ...g.state.deck,
          ...g.state.discard,
          ...g.state.players.flatMap((p) => p.hand.map((h) => h.card)),
          ...(g.state.pending ? [g.state.pending.card] : []),
        ];
        expect(all).toHaveLength(52);
        expect(new Set(all.map((c) => `${c.suit}:${c.rank}`)).size).toBe(52);
        expect(++loops).toBeLessThan(53);
      }
      expect(g.state.phase).toBe("roundEnd");
      expect(g.state.deck).toHaveLength(0);
    },
  );
  it("rejects off-turn actions without altering deck, pending or hands", () => {
    const g = active();
    const id = current(g) === "0" ? "1" : "0";
    const before = JSON.stringify(g.state);
    for (const command of [
      { type: "draw", source: "deck" },
      { type: "cabo" },
      { type: "discard" },
      { type: "swap", indices: [0] },
    ] as const)
      expect(() => g.apply(id, command as any, 10)).toThrow();
    expect(JSON.stringify(g.state)).toBe(before);
  });
  it("invalid exchange position retains all cards and permits another choice", () => {
    const g = active();
    const id = current(g),
      other = id === "0" ? "1" : "0";
    setHand(g, id, [1]);
    setHand(g, other, [2, 3]);
    g.state.deck.push(face(12));
    g.apply(id, { type: "draw", source: "deck" }, 10);
    expect(() =>
      g.apply(
        id,
        {
          type: "exchange",
          first: { playerId: id, index: 1 },
          second: { playerId: other, index: 1 },
        },
        11,
      ),
    ).toThrow();
    expect(g.state.pending?.card.rank).toBe(12);
    g.apply(
      id,
      {
        type: "exchange",
        first: { playerId: id, index: 0 },
        second: { playerId: other, index: 1 },
      },
      12,
    );
    expect(g.state.players.find((p) => p.id === id)!.hand[0].card.rank).toBe(3);
  });
  it("gives a fresh full turn after a delayed tick passes initial phases", () => {
    const g = make();
    g.tick(100001);
    expect(g.state.phase).toBe("turn");
    expect(g.state.turnDeadline).toBe(160000);
    expect(g.state.deck).toHaveLength(42);
  });
});

describe("partial initial selections", () => {
  it("remembers a single rightmost choice and fills leftmost at timeout", () => {
    const g = make();
    g.apply("0", { type: "initialSelect", indices: [3] }, 100);
    expect(g.view("0", 100).initial?.selectedIndices).toEqual([3]);
    expect(g.view("0", 100).reveal).toBeUndefined();
    g.tick(30000);
    expect(g.view("0", 30000).reveal?.cards.map((c) => c.index)).toEqual([
      0, 3,
    ]);
  });
  it("permits clearing a partial selection without extending selection deadline", () => {
    const g = make();
    g.apply("0", { type: "initialSelect", indices: [3] }, 100);
    g.apply("0", { type: "initialSelect", indices: [] }, 200);
    expect(g.view("0", 200).initial?.selectedIndices).toEqual([]);
    expect(g.view("0", 200).initial?.deadline).toBe(30000);
    g.tick(30000);
    expect(g.view("0", 30000).reveal?.cards.map((c) => c.index)).toEqual([
      0, 1,
    ]);
  });
  it("does not expose another players partial choice", () => {
    const g = make();
    g.apply("0", { type: "initialSelect", indices: [3] }, 100);
    expect(g.view("1", 100).initial?.selectedIndices).toEqual([]);
  });
});

describe("arbitrary player exchange", () => {
  it.each([11, 12])(
    "rank %i exchanges two opponents at different positions",
    (rank) => {
      const g = active(3);
      const actor = current(g);
      const [first, second] = g.state.players.filter((p) => p.id !== actor);
      const owner = g.state.players.find((p) => p.id === actor)!;
      setHand(g, first.id, [2]);
      setHand(g, second.id, [3, 4, 5]);
      second.hand[2].public = true;
      first.swapFeedback = {
        outcome: "swap-success",
        index: 0,
        deadline: 5000,
      };
      second.swapFeedback = {
        outcome: "swap-success",
        index: 2,
        deadline: 5000,
      };
      owner.swapFeedback = {
        outcome: "swap-success",
        index: 0,
        deadline: 5000,
      };
      const ownHand = structuredClone(owner.hand);
      g.state.deck.push(face(rank));
      g.apply(actor, { type: "draw", source: "deck" }, 10);
      g.apply(
        actor,
        {
          type: "exchange",
          first: { playerId: first.id, index: 0 },
          second: { playerId: second.id, index: 2 },
        },
        11,
      );
      expect(first.hand).toEqual([{ card: face(5), public: true }]);
      expect(second.hand.map((h) => h.card.rank)).toEqual([3, 4, 2]);
      expect(second.hand[2].public).toBe(false);
      expect(owner.hand).toEqual(ownHand);
      expect(owner.swapFeedback?.index).toBe(0);
      expect(first.swapFeedback).toBeUndefined();
      expect(second.swapFeedback).toBeUndefined();
      expect(g.state.pending).toBeUndefined();
      expect(g.state.discard.at(-1)?.rank).toBe(rank);
      expect(current(g)).not.toBe(actor);
      for (const viewer of g.state.players) {
        const view = g.view(viewer.id, 11);
        expect(view.reveal).toBeUndefined();
        expect(
          view.players.find((p) => p.id === second.id)!.hand[2].card,
        ).toBeUndefined();
        expect(
          view.players.find((p) => p.id === first.id)!.hand[0].card,
        ).toEqual(face(5));
      }
    },
  );

  it("exchanges own position four with opponent position one and clears only moved feedback", () => {
    const g = active();
    const actor = current(g);
    const owner = g.state.players.find((p) => p.id === actor)!;
    const other = g.state.players.find((p) => p.id !== actor)!;
    setHand(g, actor, [1, 2, 3, 4]);
    setHand(g, other.id, [6]);
    owner.swapFeedback = { outcome: "swap-success", index: 3, deadline: 5000 };
    other.swapFeedback = { outcome: "swap-success", index: 0, deadline: 5000 };
    g.state.deck.push(face(12));
    g.apply(actor, { type: "draw", source: "deck" }, 10);
    g.apply(
      actor,
      {
        type: "exchange",
        first: { playerId: other.id, index: 0 },
        second: { playerId: actor, index: 3 },
      },
      11,
    );
    expect(owner.hand.map((h) => h.card.rank)).toEqual([1, 2, 3, 6]);
    expect(other.hand[0].card.rank).toBe(4);
    expect(owner.swapFeedback).toBeUndefined();
    expect(other.swapFeedback).toBeUndefined();
  });

  it.each([
    "same-player",
    "missing-player",
    "negative",
    "fraction",
    "out-of-range",
    "old-command",
    "off-turn",
    "wrong-rank",
    "discard-source",
  ])("rejects %s without changing cards", (scenario) => {
    const g = active(3);
    const actor = current(g);
    const other = g.state.players.find((p) => p.id !== actor)!.id;
    g.state.deck.push(face(scenario === "wrong-rank" ? 9 : 11));
    g.state.discard.push(face(12));
    g.apply(
      actor,
      {
        type: "draw",
        source: scenario === "discard-source" ? "discard" : "deck",
      },
      10,
    );
    const first = { playerId: actor, index: 0 };
    const second = { playerId: other, index: 3 };
    if (scenario === "same-player") second.playerId = actor;
    if (scenario === "missing-player") second.playerId = "missing";
    if (scenario === "negative") first.index = -1;
    if (scenario === "fraction") second.index = 1.5;
    if (scenario === "out-of-range") second.index = 4;
    const before = structuredClone(g.state);
    expect(() =>
      g.apply(
        scenario === "off-turn" ? other : actor,
        scenario === "old-command"
          ? { type: "skill", targetId: other, index: 0 }
          : { type: "exchange", first, second },
        11,
      ),
    ).toThrow();
    expect(g.state).toEqual(before);
  });
});

describe("public skill announcements", () => {
  it.each([
    [7, "peek"],
    [8, "peek"],
    [9, "spy"],
    [10, "spy"],
    [11, "exchange"],
    [12, "exchange"],
  ] as const)(
    "rank %i announces %s without private card data",
    (rank, kind) => {
      const g = active(3);
      const actor = current(g);
      const other = g.state.players.find((p) => p.id !== actor)!.id;
      g.state.deck.push(face(rank));
      g.apply(actor, { type: "draw", source: "deck" }, 10);
      g.apply(
        actor,
        rank >= 11
          ? {
              type: "exchange",
              first: { playerId: actor, index: 0 },
              second: { playerId: other, index: 2 },
            }
          : { type: "skill", targetId: rank <= 8 ? actor : other, index: 0 },
        11,
      );
      for (const player of g.state.players) {
        const notice = g.view(player.id, 11).logs.find((l) => l.skill);
        expect(notice).toMatchObject({
          at: 11,
          skill: { actorId: actor, kind },
        });
        expect(Object.keys(notice!.skill!).sort()).toEqual(
          kind === "spy"
            ? ["actorId", "index", "kind", "targetId"]
            : ["actorId", "kind"],
        );
        if (kind === "spy")
          expect(notice!.skill).toMatchObject({ targetId: other, index: 0 });
        if (kind === "exchange") {
          const actorName = g.state.players.find((p) => p.id === actor)!.name;
          const otherName = g.state.players.find((p) => p.id === other)!.name;
          expect(notice!.text).toBe(
            `${actorName}发动了交换技能：${actorName}第 1 张 ↔ ${otherName}第 3 张。`,
          );
          expect(g.spectatorView(11).logs.find((l) => l.skill)?.text).toBe(
            notice!.text,
          );
        }
        if (player.id !== actor)
          expect(g.view(player.id, 11).reveal).toBeUndefined();
      }
    },
  );
});

describe("public discard cards", () => {
  it("publishes discard draw independently of private pending and clones its face", () => {
    const g = active();
    const actor = current(g);
    g.state.discard.push(face(6, "hearts"));
    g.apply(actor, { type: "draw", source: "discard" }, 10);
    for (const view of [
      g.view(actor, 10),
      g.view("1", 10),
      g.spectatorView(20),
    ]) {
      expect(view.publicDraw).toEqual({
        actorId: actor,
        card: face(6, "hearts"),
      });
    }
    const observer = g.spectatorView(20);
    expect(observer.pending).toBeUndefined();
    observer.publicDraw!.card.rank = 99;
    expect(g.state.pending!.card.rank).toBe(6);
    g.apply(actor, { type: "discard" }, 21);
    expect(g.spectatorView(21).publicDraw).toBeUndefined();
    g.apply(current(g), { type: "draw", source: "deck" }, 22);
    expect(g.spectatorView(22).publicDraw).toBeUndefined();
  });
  it.each([
    [[1, 2, 3], [1], 1],
    [[4, 8, 4], [0, 2], 0],
    [[4, 8, 5], [0, 2], 3],
  ])(
    "keeps incoming discard public through swap %j at %j",
    (ranks, indices, position) => {
      const g = active();
      const actor = current(g);
      setHand(g, actor, ranks as number[]);
      g.state.discard.push(face(6));
      g.apply(actor, { type: "draw", source: "discard" }, 10);
      g.apply(actor, { type: "swap", indices: indices as number[] }, 11);
      const view = g.spectatorView(12);
      expect(
        view.players.find((p) => p.id === actor)!.hand[position as number],
      ).toEqual({ index: position, public: true, card: face(6) });
      expect(view.publicDraw).toBeUndefined();
    },
  );
  it("moves a discard-origin public card with J/Q and removes visibility when replaced", () => {
    const g = active();
    const actor = current(g),
      other = g.state.players.find((p) => p.id !== actor)!.id;
    g.state.discard.push(face(6));
    g.apply(actor, { type: "draw", source: "discard" }, 10);
    g.apply(actor, { type: "swap", indices: [1] }, 11);
    g.state.deck.push(face(12));
    g.apply(other, { type: "draw", source: "deck" }, 12);
    g.apply(
      other,
      {
        type: "exchange",
        first: { playerId: actor, index: 1 },
        second: { playerId: other, index: 2 },
      },
      13,
    );
    expect(
      g.spectatorView(13).players.find((p) => p.id === other)!.hand[2],
    ).toMatchObject({ public: true, card: face(6) });
    g.apply(actor, { type: "draw", source: "deck" }, 14);
    g.apply(actor, { type: "discard" }, 15);
    g.apply(other, { type: "draw", source: "deck" }, 16);
    g.apply(other, { type: "swap", indices: [2] }, 17);
    expect(
      g.spectatorView(17).players.find((p) => p.id === other)!.hand[2],
    ).toEqual({ index: 2, public: false });
    expect(g.spectatorView(17).discardTop).toEqual(face(6));
  });
});

describe("CABO penalty boundaries", () => {
  it.each([
    [67, false, 50, true, "roundEnd"],
    [67, true, 100, false, "roundEnd"],
    [68, false, 101, false, "gameOver"],
  ] as const)(
    "applies plus ten before total %i with resetUsed %s",
    (total, used, expected, reset, phase) => {
      const g = active();
      const actor = current(g);
      setHand(g, actor, [11, 12]);
      setHand(g, "1", [1]);
      g.state.players[0].total = total;
      g.state.players[0].resetUsed = used;
      g.apply(actor, { type: "cabo" }, 10);
      g.apply(current(g), { type: "draw", source: "discard" }, 11);
      g.apply(current(g), { type: "discard" }, 12);
      expect(g.state.results!.find((r) => r.playerId === actor)).toMatchObject({
        raw: 23,
        round: 33,
        total: expected,
        reset,
        reason: "cabo-failed",
      });
      expect(g.state.phase).toBe(phase);
    },
  );
});
