export type Suit =
  "spades" | "hearts" | "diamonds" | "clubs" | "joker-black" | "joker-red";
export interface CardFace {
  rank: number;
  suit: Suit;
}
export type Phase = "lobby" | "initial" | "turn" | "roundEnd" | "gameOver";
export interface CardPosition {
  playerId: string;
  index: number;
}
export type GameCommand =
  | { type: "ready"; ready: boolean }
  | { type: "start" }
  | { type: "leave" }
  | { type: "kick"; targetId: string }
  | { type: "endGame"; confirm: true }
  | { type: "nextRound" }
  | { type: "restart" }
  | { type: "initialSelect"; indices: number[] }
  | { type: "closeReveal" }
  | { type: "draw"; source: "deck" | "discard" }
  | { type: "discard" }
  | { type: "swap"; indices: number[] }
  | { type: "skill"; targetId: string; index: number }
  | { type: "exchange"; first: CardPosition; second: CardPosition }
  | { type: "cabo" };
export interface CommandEnvelope {
  requestId: string;
  version: number;
  command: GameCommand;
}
export interface RuleErrorInfo {
  code: string;
  message: string;
}
export interface Ack {
  ok: boolean;
  error?: RuleErrorInfo;
  view?: PlayerView;
}
export interface VisibleCard {
  index: number;
  public: boolean;
  card?: CardFace;
}
export interface PlayerSummary {
  id: string;
  name: string;
  connected: boolean;
  ready: boolean;
  total: number;
  resetUsed: boolean;
  hand: VisibleCard[];
}
export interface Reveal {
  cards: { playerId: string; index: number; card: CardFace }[];
  deadline: number;
}
export interface SwapFeedback {
  outcome: "swap-success" | "merge-success" | "merge-failed";
  index: number;
  deadline: number;
}
export interface RoundResult {
  playerId: string;
  name: string;
  hand: CardFace[];
  raw: number;
  round: number;
  total: number;
  reason:
    "normal" | "cabo-success" | "cabo-failed" | "special" | "special-opponent";
  reset: boolean;
}
export type SkillAnnouncement =
  | { actorId: string; kind: "peek" | "exchange" }
  | { actorId: string; kind: "spy"; targetId: string; index: number };
export interface GameLog {
  skill?: SkillAnnouncement;
  id: number;
  at: number;
  text: string;
}
export interface PlayerView {
  role: "player";
  version: number;
  serverNow: number;
  phase: Phase;
  selfId: string;
  hostId: string;
  players: PlayerSummary[];
  round: number;
  turnPlayerId?: string;
  turnDeadline?: number;
  initial?: {
    status: "selecting" | "revealing" | "done";
    deadline: number;
    doneIds: string[];
    selectedIndices?: number[];
  };
  reveal?: Reveal;
  swapFeedback?: SwapFeedback;
  pending?: { card: CardFace; source: "deck" | "discard" };
  publicDraw?: { actorId: string; card: CardFace };
  discardTop?: CardFace;
  deckCount: number;
  caboCallerId?: string;
  remainingFinalTurns?: number;
  results?: RoundResult[];
  nextRoundAt?: number;
  winners?: string[];
  logs: GameLog[];
}

export interface SpectatorView extends Omit<
  PlayerView,
  "role" | "selfId" | "initial" | "reveal" | "swapFeedback" | "pending"
> {
  role: "spectator";
  selfId?: never;
  initial?: never;
  reveal?: never;
  swapFeedback?: never;
  pending?: never;
}
export type RoomView = PlayerView | SpectatorView;
export interface WatchAck {
  ok: boolean;
  error?: RuleErrorInfo;
  view?: SpectatorView;
}
