import type {
  CardFace,
  GameCommand,
  GameLog,
  Phase,
  PlayerView,
  SpectatorView,
  Reveal,
  RoundResult,
  SwapFeedback,
} from "./types";

export class RuleError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RuleError";
  }
}
function requireRule(
  value: unknown,
  code: string,
  message: string,
): asserts value {
  if (!value) throw new RuleError(code, message);
}
export function createDeck(): CardFace[] {
  const cards: CardFace[] = [];
  for (const suit of ["spades", "hearts", "diamonds", "clubs"] as const)
    for (let rank = 1; rank <= 12; rank++) cards.push({ rank, suit });
  cards.push(
    { rank: 13, suit: "spades" },
    { rank: 13, suit: "hearts" },
    { rank: 0, suit: "joker-black" },
    { rank: 0, suit: "joker-red" },
  );
  return cards;
}
export const scoreHand = (cards: CardFace[]): number =>
  cards.reduce((sum, c) => sum + c.rank, 0);
export interface HandCard {
  card: CardFace;
  public: boolean;
}
export interface EnginePlayer {
  id: string;
  name: string;
  total: number;
  resetUsed: boolean;
  hand: HandCard[];
  initialStatus: "selecting" | "revealing" | "done";
  initialDeadline: number;
  selectedIndices: number[];
  reveal?: Reveal;
  swapFeedback?: SwapFeedback;
}
export interface EngineState {
  version: number;
  phase: Phase;
  players: EnginePlayer[];
  round: number;
  starterIndex: number;
  turnIndex: number;
  turnDeadline?: number;
  deck: CardFace[];
  discard: CardFace[];
  pending?: { playerId: string; card: CardFace; source: "deck" | "discard" };
  skillRevealPlayerId?: string;
  caboCallerId?: string;
  remainingFinalTurns?: number;
  results?: RoundResult[];
  nextRoundAt?: number;
  winners?: string[];
  logs: GameLog[];
}
export interface EngineOptions {
  random?: () => number;
  now?: number;
}
export class GameEngine {
  readonly state: EngineState;
  private readonly random: () => number;
  private logSequence = 0;
  constructor(
    players: { id: string; name: string }[],
    options: EngineOptions = {},
  ) {
    requireRule(
      players.length >= 2 && players.length <= 4,
      "PLAYER_COUNT",
      "需要 2–4 位玩家",
    );
    requireRule(
      new Set(players.map((p) => p.id)).size === players.length,
      "PLAYER_IDS",
      "玩家标识不能重复",
    );
    this.random = options.random ?? Math.random;
    const now = options.now ?? Date.now();
    const starterIndex = Math.min(
      players.length - 1,
      Math.max(0, Math.floor(this.random() * players.length)),
    );
    this.state = {
      version: 0,
      phase: "initial",
      players: players.map((p) => ({
        ...p,
        total: 0,
        resetUsed: false,
        hand: [],
        initialStatus: "selecting",
        initialDeadline: now + 30000,
        selectedIndices: [],
      })),
      round: 0,
      starterIndex,
      turnIndex: starterIndex,
      deck: [],
      discard: [],
      logs: [],
    };
    this.startRound(now);
  }
  private log(text: string, at: number, skill?: GameLog["skill"]) {
    this.state.logs.push({
      id: ++this.logSequence,
      at,
      text,
      ...(skill ? { skill } : {}),
    });
    if (this.state.logs.length > 80) this.state.logs.shift();
  }
  private startRound(now: number) {
    const s = this.state;
    s.round++;
    s.phase = "initial";
    s.turnIndex = s.starterIndex;
    delete s.turnDeadline;
    delete s.pending;
    delete s.skillRevealPlayerId;
    delete s.caboCallerId;
    delete s.remainingFinalTurns;
    delete s.results;
    delete s.nextRoundAt;
    delete s.winners;
    s.deck = createDeck();
    for (let i = s.deck.length - 1; i > 0; i--) {
      const j = Math.min(i, Math.max(0, Math.floor(this.random() * (i + 1))));
      [s.deck[i], s.deck[j]] = [s.deck[j], s.deck[i]];
    }
    for (const p of s.players) {
      p.hand = Array.from({ length: 4 }, () => ({
        card: s.deck.pop()!,
        public: false,
      }));
      p.initialStatus = "selecting";
      p.initialDeadline = now + 30000;
      p.selectedIndices = [];
      delete p.reveal;
      delete p.swapFeedback;
    }
    s.discard = [s.deck.pop()!];
    s.version++;
    this.log(`第 ${s.round} 轮开始，请选择两张牌查看`, now);
  }
  private player(id: string) {
    const p = this.state.players.find((p) => p.id === id);
    requireRule(p, "PLAYER_NOT_FOUND", "玩家不在本局中");
    return p;
  }
  private indices(indices: number[], hand: HandCard[], exact?: number) {
    requireRule(
      Array.isArray(indices) &&
        indices.length > 0 &&
        (exact === undefined || indices.length === exact) &&
        new Set(indices).size === indices.length &&
        indices.every((i) => Number.isInteger(i) && i >= 0 && i < hand.length),
      "INVALID_SELECTION",
      exact ? `请选择 ${exact} 个不同的有效位置` : "请选择不同的有效位置",
    );
    return [...indices].sort((a, b) => a - b);
  }
  private initialSelect(p: EnginePlayer, indices: number[], now: number) {
    requireRule(
      p.initialStatus === "selecting",
      "ALREADY_SELECTED",
      "已经完成选牌",
    );
    requireRule(
      Array.isArray(indices) && indices.length <= 2,
      "INVALID_SELECTION",
      "初始查看最多选择两张牌",
    );
    const sorted = indices.length ? this.indices(indices, p.hand) : [];
    p.selectedIndices = sorted;
    if (sorted.length < 2) return;
    p.initialStatus = "revealing";
    p.initialDeadline = now + 10000;
    p.reveal = {
      cards: sorted.map((index) => ({
        playerId: p.id,
        index,
        card: p.hand[index].card,
      })),
      deadline: p.initialDeadline,
    };
  }
  private maybeBegin(now: number) {
    if (this.state.players.every((p) => p.initialStatus === "done")) {
      this.state.phase = "turn";
      this.state.turnDeadline = now + 60000;
      this.log(`${this.state.players[this.state.turnIndex].name} 的回合`, now);
    }
  }
  private finishTurn(now: number, caboJustCalled = false) {
    const s = this.state;
    delete s.pending;
    delete s.skillRevealPlayerId;
    for (const p of s.players) delete p.reveal;
    if (s.remainingFinalTurns !== undefined && !caboJustCalled)
      s.remainingFinalTurns--;
    if (s.deck.length === 0 || s.remainingFinalTurns === 0) {
      this.settle(now);
      return;
    }
    s.turnIndex = (s.turnIndex + 1) % s.players.length;
    s.turnDeadline = now + 60000;
    this.log(`${s.players[s.turnIndex].name} 的回合`, now);
  }
  private settle(now: number) {
    const s = this.state;
    for (const p of s.players) delete p.swapFeedback;
    const raw = s.players.map((p) => scoreHand(p.hand.map((h) => h.card)));
    const specials = s.players.map(
      (p) =>
        p.hand.length === 4 &&
        p.hand.filter((h) => h.card.rank === 12).length === 2 &&
        p.hand.filter((h) => h.card.rank === 13).length === 2,
    );
    s.results = s.players.map((p, i) => {
      let round = raw[i];
      let reason: RoundResult["reason"] = "normal";
      if (specials.some(Boolean)) {
        round = specials[i] ? 0 : 50;
        reason = specials[i] ? "special" : "special-opponent";
      } else if (p.id === s.caboCallerId) {
        const success = raw[i] === Math.min(...raw);
        round = success ? 0 : raw[i] + 10;
        reason = success ? "cabo-success" : "cabo-failed";
      }
      p.total += round;
      const reset = p.total === 100 && !p.resetUsed;
      if (reset) {
        p.total = 50;
        p.resetUsed = true;
      }
      return {
        playerId: p.id,
        name: p.name,
        hand: p.hand.map((h) => ({ ...h.card })),
        raw: raw[i],
        round,
        total: p.total,
        reason,
        reset,
      };
    });
    s.phase = s.players.some((p) => p.total > 100) ? "gameOver" : "roundEnd";
    if (s.phase === "gameOver") {
      const minimum = Math.min(...s.players.map((p) => p.total));
      s.winners = s.players.filter((p) => p.total === minimum).map((p) => p.id);
    }
    delete s.turnDeadline;
    s.nextRoundAt = now + 8000;
    this.log(
      s.phase === "gameOver" ? "游戏结束，总分最低者获胜" : "本轮结束",
      now,
    );
  }
  apply(playerId: string, command: GameCommand, now: number): void {
    this.tick(now);
    const s = this.state,
      p = this.player(playerId);
    requireRule(
      command && typeof command.type === "string",
      "INVALID_COMMAND",
      "无效操作",
    );
    if (command.type === "nextRound") {
      requireRule(
        s.phase === "roundEnd" && now >= s.nextRoundAt!,
        "ROUND_NOT_READY",
        "结算展示至少 8 秒后才能开始下一轮",
      );
      s.starterIndex = (s.starterIndex + 1) % s.players.length;
      this.startRound(now);
      return;
    }
    if (command.type === "restart") {
      requireRule(
        s.phase === "gameOver" && now >= s.nextRoundAt!,
        "RESTART_NOT_READY",
        "游戏结束且结算展示至少 8 秒后才能重新开始",
      );
      for (const player of s.players) {
        player.total = 0;
        player.resetUsed = false;
      }
      s.round = 0;
      s.starterIndex = Math.min(
        s.players.length - 1,
        Math.max(0, Math.floor(this.random() * s.players.length)),
      );
      s.logs = [];
      this.startRound(now);
      return;
    }
    if (s.phase === "initial") {
      if (command.type === "initialSelect")
        this.initialSelect(p, command.indices, now);
      else if (command.type === "closeReveal") {
        requireRule(
          p.initialStatus === "revealing",
          "NO_REVEAL",
          "当前没有查看中的牌",
        );
        p.initialStatus = "done";
        delete p.reveal;
        this.maybeBegin(now);
      } else throw new RuleError("INITIAL_PHASE", "请先完成初始牌面查看");
      s.version++;
      return;
    }
    requireRule(s.phase === "turn", "NOT_PLAYING", "当前不在出牌阶段");
    requireRule(
      s.players[s.turnIndex].id === playerId,
      "NOT_YOUR_TURN",
      "还没轮到你",
    );
    if (s.skillRevealPlayerId) {
      requireRule(
        command.type === "closeReveal",
        "REVEAL_OPEN",
        "请先关闭查看",
      );
      this.finishTurn(now);
      s.version++;
      return;
    }
    if (command.type === "cabo") {
      requireRule(
        !s.pending && !s.caboCallerId,
        "CABO_UNAVAILABLE",
        "只能在摸牌前且无人宣告时宣告 CABO",
      );
      s.caboCallerId = playerId;
      s.remainingFinalTurns = s.players.length - 1;
      this.log(`${p.name} 宣告 CABO`, now);
      this.finishTurn(now, true);
    } else if (command.type === "draw") {
      requireRule(!s.pending, "ALREADY_DRAWN", "你已经摸过牌");
      requireRule(
        command.source === "deck" || command.source === "discard",
        "INVALID_SOURCE",
        "无效牌堆",
      );
      const pile = command.source === "deck" ? s.deck : s.discard;
      requireRule(pile.length > 0, "EMPTY_PILE", "牌堆已空");
      s.pending = { playerId, card: pile.pop()!, source: command.source };
      this.log(
        `${p.name} 从${command.source === "deck" ? "牌堆" : "弃牌堆"}摸牌`,
        now,
      );
    } else if (command.type === "discard") {
      requireRule(s.pending, "DRAW_REQUIRED", "请先摸牌");
      s.discard.push(s.pending.card);
      this.log(`${p.name} 弃牌`, now);
      this.finishTurn(now);
    } else if (command.type === "swap") {
      requireRule(s.pending, "DRAW_REQUIRED", "请先摸牌");
      const indices = this.indices(command.indices, p.hand),
        incoming = s.pending.card,
        incomingPublic = s.pending.source === "discard";
      const success = indices.every(
        (i) => p.hand[i].card.rank === p.hand[indices[0]].card.rank,
      );
      if (success) {
        s.discard.push(...indices.map((i) => p.hand[i].card));
        p.hand = p.hand.flatMap((h, i) =>
          i === indices[0]
            ? [{ card: incoming, public: incomingPublic }]
            : indices.includes(i)
              ? []
              : [h],
        );
      } else {
        for (const i of indices) p.hand[i].public = true;
        p.hand.push({ card: incoming, public: incomingPublic });
      }
      p.swapFeedback = {
        outcome: success
          ? indices.length === 1
            ? "swap-success"
            : "merge-success"
          : "merge-failed",
        index: success ? indices[0] : p.hand.length - 1,
        deadline: now + 5000,
      };
      this.log(
        `${p.name} ${success ? "换牌成功" : "换牌失败，所选牌公开并增加一张牌"}`,
        now,
      );
      this.finishTurn(now);
    } else if (command.type === "skill") {
      requireRule(
        s.pending && s.pending.source === "deck",
        "SKILL_UNAVAILABLE",
        "只有从牌堆摸到的功能牌能使用技能",
      );
      const rank = s.pending.card.rank,
        target = this.player(command.targetId);
      requireRule(
        Number.isInteger(command.index) &&
          command.index >= 0 &&
          command.index < target.hand.length,
        "INVALID_POSITION",
        "目标位置没有牌",
      );
      requireRule(
        rank >= 7 && rank <= 10,
        "NOT_SKILL_CARD",
        "查看技能需要 7、8、9 或 10",
      );
      requireRule(
        rank <= 8 ? target.id === p.id : target.id !== p.id,
        "INVALID_TARGET",
        rank <= 8 ? "这张牌只能查看自己的牌" : "这张牌只能查看其他玩家的牌",
      );
      p.reveal = {
        cards: [
          {
            playerId: target.id,
            index: command.index,
            card: { ...target.hand[command.index].card },
          },
        ],
        deadline: Math.min(now + 5000, s.turnDeadline!),
      };
      s.discard.push(s.pending.card);
      delete s.pending;
      s.skillRevealPlayerId = p.id;
      this.log(
        rank <= 8
          ? `${p.name} 发动了偷看技能`
          : `${p.name}查看了${target.name}的第${command.index + 1}张牌`,
        now,
        rank <= 8
          ? { actorId: p.id, kind: "peek" }
          : {
              actorId: p.id,
              kind: "spy",
              targetId: target.id,
              index: command.index,
            },
      );
    } else if (command.type === "exchange") {
      requireRule(
        s.pending && s.pending.source === "deck",
        "SKILL_UNAVAILABLE",
        "只有从牌堆摸到的功能牌能使用技能",
      );
      requireRule(
        s.pending.card.rank === 11 || s.pending.card.rank === 12,
        "NOT_SKILL_CARD",
        "交换技能需要 J 或 Q",
      );
      const first = this.player(command.first.playerId);
      const second = this.player(command.second.playerId);
      requireRule(
        first.id !== second.id,
        "INVALID_TARGET",
        "请选择两名不同玩家各一张牌",
      );
      for (const [player, position] of [
        [first, command.first],
        [second, command.second],
      ] as const)
        requireRule(
          Number.isInteger(position.index) &&
            position.index >= 0 &&
            position.index < player.hand.length,
          "INVALID_POSITION",
          "目标位置没有牌",
        );
      [first.hand[command.first.index], second.hand[command.second.index]] = [
        second.hand[command.second.index],
        first.hand[command.first.index],
      ];
      for (const [player, position] of [
        [first, command.first],
        [second, command.second],
      ] as const)
        if (player.swapFeedback?.index === position.index)
          delete player.swapFeedback;
      s.discard.push(s.pending.card);
      this.log(
        `${p.name}发动了交换技能：${first.name}第 ${command.first.index + 1} 张 ↔ ${second.name}第 ${command.second.index + 1} 张。`,
        now,
        { actorId: p.id, kind: "exchange" },
      );
      this.finishTurn(now);
    } else throw new RuleError("INVALID_COMMAND", "当前不能执行此操作");
    s.version++;
  }
  tick(now: number): boolean {
    const s = this.state;
    let changed = false;
    // Process due events in timestamp order so pauses never extend a deadline.
    for (let guard = 0; guard < 1000; guard++) {
      if (s.phase === "initial") {
        const due = s.players
          .filter((p) => p.initialStatus !== "done" && p.initialDeadline <= now)
          .sort((a, b) => a.initialDeadline - b.initialDeadline)[0];
        if (!due) break;
        const at = due.initialDeadline;
        if (due.initialStatus === "selecting") {
          const selected = [...due.selectedIndices];
          for (let i = 0; selected.length < 2; i++)
            if (!selected.includes(i)) selected.push(i);
          this.initialSelect(due, selected, at);
        } else {
          due.initialStatus = "done";
          delete due.reveal;
          this.maybeBegin(at);
        }
        changed = true;
        s.version++;
        continue;
      }
      if (s.phase !== "turn") break;
      const actor = s.players[s.turnIndex];
      if (
        s.skillRevealPlayerId &&
        actor.reveal &&
        actor.reveal.deadline <= now
      ) {
        this.finishTurn(actor.reveal.deadline);
        changed = true;
        s.version++;
        continue;
      }
      if (s.turnDeadline! > now) break;
      const at = s.turnDeadline!;
      if (s.pending) s.discard.push(s.pending.card);
      else if (s.deck.length) s.discard.push(s.deck.pop()!);
      this.log(`${actor.name} 回合超时，自动弃牌`, at);
      this.finishTurn(at);
      changed = true;
      s.version++;
    }
    return changed;
  }
  private publicView(now: number): SpectatorView {
    const s = this.state;
    const ended = s.phase === "roundEnd" || s.phase === "gameOver";
    const result: SpectatorView = {
      role: "spectator",
      version: s.version,
      serverNow: now,
      phase: s.phase,
      hostId: s.players[0].id,
      players: s.players.map((p) => ({
        id: p.id,
        name: p.name,
        connected: true,
        ready: true,
        total: p.total,
        resetUsed: p.resetUsed,
        hand: p.hand.map((h, index) => ({
          index,
          public: h.public,
          ...(h.public || ended ? { card: { ...h.card } } : {}),
        })),
      })),
      round: s.round,
      deckCount: s.deck.length,
      logs: s.logs.map((log) => ({
        ...log,
        ...(log.skill ? { skill: { ...log.skill } } : {}),
      })),
    };
    if (s.pending?.source === "discard")
      result.publicDraw = {
        actorId: s.pending.playerId,
        card: { ...s.pending.card },
      };
    if (s.discard.length)
      result.discardTop = { ...s.discard[s.discard.length - 1] };
    if (s.caboCallerId) {
      result.caboCallerId = s.caboCallerId;
      result.remainingFinalTurns = s.remainingFinalTurns;
    }
    if (s.results) result.results = structuredClone(s.results);
    if (s.nextRoundAt !== undefined) result.nextRoundAt = s.nextRoundAt;
    if (s.winners) result.winners = [...s.winners];
    if (s.phase === "turn") {
      result.turnPlayerId = s.players[s.turnIndex].id;
      result.turnDeadline = s.turnDeadline;
    }
    return result;
  }
  spectatorView(now: number): SpectatorView {
    this.tick(now);
    return this.publicView(now);
  }
  view(playerId: string, now: number): PlayerView {
    this.tick(now);
    const s = this.state,
      self = this.player(playerId);
    const result: PlayerView = {
      ...this.publicView(now),
      role: "player",
      selfId: playerId,
    };
    if (s.phase === "initial")
      result.initial = {
        status: self.initialStatus,
        deadline: self.initialDeadline,
        doneIds: s.players
          .filter((p) => p.initialStatus === "done")
          .map((p) => p.id),
        selectedIndices: [...self.selectedIndices],
      };
    if (s.phase === "turn") {
      result.turnPlayerId = s.players[s.turnIndex].id;
      result.turnDeadline = s.turnDeadline;
      if (self.swapFeedback && self.swapFeedback.deadline > now)
        result.swapFeedback = { ...self.swapFeedback };
    }
    if (self.reveal && self.reveal.deadline > now)
      result.reveal = structuredClone(self.reveal);
    if (s.pending?.playerId === playerId)
      result.pending = {
        card: { ...s.pending.card },
        source: s.pending.source,
      };
    return result;
  }
}
