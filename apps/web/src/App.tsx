import { useEffect, useState } from "react";
import type {
  CardFace,
  CardPosition,
  GameCommand,
  PlayerSummary,
  RoundResult,
} from "../../../packages/game/src/types";
import { useRoom } from "./useRoom";
export const faceUrl = (card?: CardFace) =>
  card ? `/cards/${card.suit}-${card.rank}.svg` : "/cards/back.svg";
const cardName = (c?: CardFace) =>
  c
    ? `${{ spades: "黑桃", hearts: "红桃", diamonds: "方块", clubs: "梅花", "joker-black": "小王", "joker-red": "大王" }[c.suit]}${c.rank === 0 ? "" : (({ 1: "A", 11: "J", 12: "Q", 13: "K" } as Record<number, string>)[c.rank] ?? c.rank)}`
    : "暗牌";
function Icon({ name }: { name: string }) {
  return <img className="icon" src={`/icons/${name}.svg`} alt="" />;
}
const reason: Record<RoundResult["reason"], string> = {
  normal: "按手牌计分",
  "cabo-success": "CABO 成功 · 本轮 0 分",
  "cabo-failed": "CABO 失败 · 牌分 × 2",
  special: "神锋特工队 · 本轮 0 分",
  "special-opponent": "对手神锋 · 本轮 50 分",
};
function Rules() {
  return (
    <details className="rules">
      <summary>
        玩法速查 <span>拿牌 · 换牌 · 分少获胜</span>
      </summary>
      <div className="rule-grid">
        <p>
          <b>记住位置</b>开局自选两张看 10 秒。每回合 60
          秒，摸牌后可弃置、换牌或使用技能。
        </p>
        <p>
          <b>少一点，再少一点</b>
          多张同点数可换成一张；不同则全部公开，并追加摸到的牌。A=1，J=11，Q=12，K=13，大小王=0。
        </p>
        <p>
          <b>7 / 8 · 偷看</b>查看自己一张；<b>9 / 10 · 间谍</b>查看对手一张；
          <b>J / Q · 交换</b>
          任意两名玩家各选一张交换，序号不限，也可交换两名对手的牌。技能只限摸牌堆，查看最多
          5 秒。
        </p>
        <p>
          <b>呼唤 CABO</b>抽牌前呼唤并结束回合，其他人各走一次。你并列最低得
          0，否则牌分翻倍。摸牌堆抽尽也会结算。
        </p>
        <p>
          <b>特殊计分</b>恰好 QQKK 得 0，其余人得 50。每人首次累计恰好 100 降至
          50；有人超过 100 时结束，最低总分获胜。
        </p>
        <p>
          <b>断线也能回来</b>
          同一浏览器刷新恢复座位；计时仍继续，超时自动摸牌并弃置。别清除浏览器保存的身份。
        </p>
      </div>
    </details>
  );
}
export function App() {
  const room = useRoom();
  const { view: v, connected, busy, error, send } = room;
  const [name, setName] = useState("");
  const [now, setNow] = useState(Date.now());
  const [selected, setSelected] = useState<number[]>([]);
  const [mode, setMode] = useState<"swap" | "skill" | undefined>();
  const [target, setTarget] = useState("");
  const [skillIndex, setSkillIndex] = useState<number>();
  const [exchangeCards, setExchangeCards] = useState<CardPosition[]>([]);
  const [confirm, setConfirm] = useState<"cabo" | "endGame" | undefined>();
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(timer);
  }, []);
  const serverNow = now + room.offset;
  const seconds = (deadline?: number) =>
    Math.max(0, Math.ceil(((deadline ?? serverNow) - serverNow) / 1000));
  const mine = v?.players.find((p) => p.id === v.selfId);
  const host = v?.hostId === v?.selfId;
  const myTurn = v?.phase === "turn" && v.turnPlayerId === v.selfId;
  const locked = !connected || busy;
  const acting = myTurn && seconds(v?.turnDeadline) > 0;
  const reveal =
    v?.reveal && v.reveal.deadline > serverNow && connected
      ? v.reveal
      : undefined;
  const swapFeedback =
    v?.phase === "turn" && v.swapFeedback && v.swapFeedback.deadline > serverNow
      ? v.swapFeedback
      : undefined;
  const swapMessage = swapFeedback
    ? `${
        swapFeedback.outcome === "swap-success"
          ? "换牌成功，新牌放在"
          : swapFeedback.outcome === "merge-success"
            ? "合并成功，新牌放在"
            : "合并失败，新牌追加到"
      }第 ${swapFeedback.index + 1} 张`
    : undefined;
  useEffect(() => {
    setSelected([]);
    setMode(undefined);
    setSkillIndex(undefined);
    setExchangeCards([]);
    setTarget("");
    setConfirm(undefined);
  }, [v?.phase, v?.turnPlayerId, v?.round, !!v?.pending]);
  useEffect(() => {
    if (v?.initial?.status === "selecting")
      // Two cards are an unconfirmed local draft. Partial selections must
      // match every server acknowledgement, including rejected/stale commands.
      setSelected((current) =>
        current.length === 2 ? current : (v.initial?.selectedIndices ?? []),
      );
  }, [v?.initial?.status, v?.initial?.selectedIndices]);
  const perform = async (c: GameCommand) => {
    if (await send(c)) {
      setMode(undefined);
      setSelected([]);
      setSkillIndex(undefined);
      setExchangeCards([]);
      setConfirm(undefined);
    }
  };
  const choose = async (index: number) => {
    if (v?.phase === "initial" && v.initial?.status === "selecting") {
      const next = selected.includes(index)
        ? selected.filter((i) => i !== index)
        : selected.length < 2
          ? [...selected, index]
          : selected;
      setSelected(next);
      if (next.length < 2) await send({ type: "initialSelect", indices: next });
    } else if (mode === "swap")
      setSelected(
        selected.includes(index)
          ? selected.filter((i) => i !== index)
          : [...selected, index],
      );
    else if (mode === "skill") setSkillIndex(index);
  };
  const initialPicking =
    v?.phase === "initial" &&
    v.initial?.status === "selecting" &&
    seconds(v.initial.deadline) > 0;
  const rank = v?.pending?.card.rank ?? 0;
  const skillPossible =
    acting && v?.pending?.source === "deck" && rank >= 7 && rank <= 12;
  const exchanging = mode === "skill" && (rank === 11 || rank === 12);
  const targetId = rank <= 8 ? v?.selfId : target;
  const skillNotice =
    v && v.phase !== "lobby"
      ? [...v.logs]
          .reverse()
          .find(
            (log) =>
              log.skill &&
              log.skill.actorId !== v.selfId &&
              log.at + 5000 > serverNow,
          )
      : undefined;
  const chooseExchange = (playerId: string, index: number) => {
    setExchangeCards((cards) => {
      const existing = cards.find((card) => card.playerId === playerId);
      if (existing?.index === index)
        return cards.filter((card) => card.playerId !== playerId);
      if (existing)
        return cards.map((card) =>
          card.playerId === playerId ? { playerId, index } : card,
        );
      return cards.length < 2 ? [...cards, { playerId, index }] : cards;
    });
  };
  const beginSkill = () => {
    setMode("skill");
    setSelected([]);
    setSkillIndex(undefined);
    setExchangeCards([]);
    setTarget(
      rank <= 8 ? v!.selfId : v!.players.find((p) => p.id !== v!.selfId)!.id,
    );
  };
  function hand(p: PlayerSummary, isMine = false) {
    const canSelect = exchanging
      ? acting &&
        (exchangeCards.length < 2 ||
          exchangeCards.some((card) => card.playerId === p.id))
      : isMine
        ? initialPicking ||
          (acting &&
            (mode === "swap" || (mode === "skill" && targetId === p.id)))
        : acting && mode === "skill" && targetId === p.id;
    return (
      <div className="hand" aria-label={`${p.name}的手牌`}>
        {p.hand.map((h) => {
          const isNew = isMine && swapFeedback?.index === h.index;
          const available = canSelect;
          const chosen = exchanging
            ? exchangeCards.some(
                (card) => card.playerId === p.id && card.index === h.index,
              )
            : isMine && mode !== "skill"
              ? selected.includes(h.index)
              : mode === "skill" && targetId === p.id && skillIndex === h.index;
          return (
            <button
              className={`card-slot ${chosen ? "selected" : ""} ${h.public ? "exposed" : ""} ${isNew ? "new-card" : ""}`}
              key={h.index}
              aria-label={`${isMine ? "我的牌" : p.name + "的牌"} 第 ${h.index + 1} 张`}
              aria-pressed={chosen}
              disabled={locked || !available}
              onClick={() =>
                exchanging
                  ? chooseExchange(p.id, h.index)
                  : isMine
                    ? void choose(h.index)
                    : setSkillIndex(h.index)
              }
            >
              <span className="position">
                {String(h.index + 1).padStart(2, "0")}
              </span>
              <img
                key={isNew ? swapFeedback.deadline : "card"}
                src={faceUrl(h.card)}
                alt={cardName(h.card)}
              />
              <span className="card-note">
                {isNew
                  ? "新换入"
                  : h.public
                    ? "已公开"
                    : chosen
                      ? "已选择"
                      : " "}
              </span>
            </button>
          );
        })}
      </div>
    );
  }
  const phaseLabel = !v
    ? "欢迎来到牌桌"
    : v.phase === "lobby"
      ? "等待入座"
      : v.phase === "initial"
        ? "记住你的牌"
        : v.phase === "turn"
          ? myTurn
            ? "轮到你了"
            : `${v.players.find((p) => p.id === v.turnPlayerId)?.name} 的回合`
          : v.phase === "gameOver"
            ? "本场结束"
            : "本轮结算";
  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href="/" aria-label="CABO 首页">
          CABO<span>林间牌桌</span>
        </a>
        <div className={`connection ${connected ? "online" : ""}`}>
          <span className="status-dot" />
          {connected ? "已连接" : "连接中"}
          <span className="desktop-only"> · 局域网房间</span>
        </div>
      </header>
      {skillNotice?.skill && (
        <div className="skill-notice" role="status" data-testid="skill-notice">
          {v?.players.find((p) => p.id === skillNotice.skill!.actorId)?.name}{" "}
          发动了
          {
            { peek: "偷看", spy: "间谍", exchange: "交换" }[
              skillNotice.skill.kind
            ]
          }
          技能
        </div>
      )}
      <main>
        {!v ? (
          <section className="welcome">
            <div className="eyebrow">A LITTLE MEMORY. A LITTLE LUCK.</div>
            <h1>
              记住你的牌，
              <br />
              <em>留下一点运气。</em>
            </h1>
            <p className="intro">
              一张牌的秘密，一桌人的较量。
              <br />
              和同一局域网的朋友，一起寻找 CABO。
            </p>
            <div className="welcome-cards" aria-hidden="true">
              <img src="/cards/back.svg" />
              <img src="/cards/hearts-12.svg" />
              <img src="/cards/spades-1.svg" />
            </div>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void room.join(name);
              }}
              className="join-form"
            >
              <label htmlFor="nickname">你的昵称</label>
              <div>
                <input
                  id="nickname"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={24}
                  placeholder="大家怎么称呼你？"
                  autoComplete="off"
                  required
                />
                <button
                  className="primary"
                  disabled={busy || !name.trim()}
                  type="submit"
                >
                  入座
                </button>
              </div>
              <small>2–4 人 · 手机 / 电脑 · 无需注册</small>
            </form>
          </section>
        ) : (
          <>
            <div className="heading-row">
              <div>
                <div className="eyebrow">
                  {v.phase === "lobby"
                    ? "THE TABLE IS YOURS"
                    : `ROUND ${String(v.round).padStart(2, "0")}`}
                </div>
                <h1>{phaseLabel}</h1>
              </div>
              {v.phase === "turn" && (
                <div
                  className={`clock ${seconds(v.turnDeadline) <= 10 ? "urgent" : ""}`}
                >
                  <Icon name="timer" />
                  <b>{seconds(v.turnDeadline)}</b>
                  <span>秒</span>
                </div>
              )}
              {v.phase === "initial" && (
                <div className="clock">
                  <Icon name="timer" />
                  <b>{seconds(v.initial?.deadline)}</b>
                  <span>秒</span>
                </div>
              )}
            </div>
            {v.phase === "lobby" ? (
              <section className="lobby">
                <div className="seat-grid">
                  {[0, 1, 2, 3].map((i) => {
                    const p = v.players[i];
                    return (
                      <article
                        className={`seat ${p ? "occupied" : ""}`}
                        key={i}
                      >
                        <span className="seat-number">SEAT 0{i + 1}</span>
                        <div className="avatar">
                          {p ? p.name.slice(0, 1) : "＋"}
                        </div>
                        <h2>{p?.name ?? "等一位朋友"}</h2>
                        <p>
                          {p
                            ? `${p.connected ? "在线" : "暂时离线"} · ${p.ready ? "已准备" : "未准备"}`
                            : "用浏览器打开相同地址加入"}
                        </p>
                        {p?.id === v.hostId && (
                          <span className="tag">房主</span>
                        )}
                        {p?.id === v.selfId && (
                          <span className="tag subtle">你</span>
                        )}
                        {p && host && p.id !== v.selfId && (
                          <button
                            className="text-button remove"
                            onClick={() =>
                              void send({ type: "kick", targetId: p.id })
                            }
                          >
                            移除席位
                          </button>
                        )}
                      </article>
                    );
                  })}
                </div>
                <div className="lobby-actions">
                  <button
                    className={mine?.ready ? "secondary" : "primary"}
                    disabled={locked}
                    onClick={() =>
                      void send({ type: "ready", ready: !mine?.ready })
                    }
                  >
                    {mine?.ready ? "取消准备" : "准备"}
                  </button>
                  {host && (
                    <button
                      className="primary"
                      disabled={
                        locked ||
                        v.players.length < 2 ||
                        !v.players.every((p) => p.ready && p.connected)
                      }
                      onClick={() => void send({ type: "start" })}
                    >
                      开始游戏
                    </button>
                  )}
                  <span>
                    {v.players.length < 2
                      ? "再邀请一位朋友，就可以开始了。"
                      : "所有人准备后，由房主开始。"}
                  </span>
                  <button
                    className="text-button"
                    disabled={locked}
                    onClick={() => void send({ type: "leave" })}
                  >
                    离开房间
                  </button>
                </div>
              </section>
            ) : (
              <>
                <div className="score-strip">
                  {v.players.map((p) => (
                    <div
                      key={p.id}
                      className={p.id === v.turnPlayerId ? "current" : ""}
                    >
                      <span
                        className={`status-dot ${p.connected ? "" : "offline"}`}
                      />
                      <span>
                        {p.name}
                        {p.id === v.selfId ? "（你）" : ""}
                      </span>
                      <b>
                        {p.total}
                        <small> 分</small>
                      </b>
                      {p.resetUsed && (
                        <span
                          className="reset-used"
                          title="本场100分重置已使用"
                        >
                          ↺
                        </span>
                      )}
                    </div>
                  ))}
                </div>
                {v.caboCallerId && (
                  <div className="cabo-banner">
                    <Icon name="cabo" />
                    <b>
                      {v.players.find((p) => p.id === v.caboCallerId)?.name}{" "}
                      呼唤了 CABO
                    </b>
                    <span>最后 {v.remainingFinalTurns ?? 0} 人行动</span>
                  </div>
                )}
                {v.phase === "roundEnd" || v.phase === "gameOver" ? (
                  <section className="results">
                    <h2>{v.phase === "gameOver" ? "本场赢家" : "本轮结算"}</h2>
                    {v.phase === "gameOver" && (
                      <p className="winners">
                        {v.players
                          .filter((p) => v.winners?.includes(p.id))
                          .map((p) => p.name)
                          .join(" · ")}
                        <span>最低累计分获胜</span>
                      </p>
                    )}
                    <div className="result-grid">
                      {v.results?.map((r) => (
                        <article className="result" key={r.playerId}>
                          <h3>{r.name}</h3>
                          <div className="result-hand">
                            {r.hand.map((c, i) => (
                              <img src={faceUrl(c)} alt={cardName(c)} key={i} />
                            ))}
                          </div>
                          <p>{reason[r.reason]}</p>
                          <dl>
                            <div>
                              <dt>手牌分</dt>
                              <dd>{r.raw}</dd>
                            </div>
                            <div>
                              <dt>本轮</dt>
                              <dd>+{r.round}</dd>
                            </div>
                            <div>
                              <dt>累计</dt>
                              <dd>{r.total}</dd>
                            </div>
                          </dl>
                          {r.reset && (
                            <p className="gold">首次恰好 100 分 → 50 分</p>
                          )}
                        </article>
                      ))}
                    </div>
                    <div className="result-actions">
                      {host ? (
                        <button
                          className="primary"
                          disabled={locked || seconds(v.nextRoundAt) > 0}
                          onClick={() =>
                            void perform({
                              type:
                                v.phase === "gameOver"
                                  ? "restart"
                                  : "nextRound",
                            })
                          }
                        >
                          {v.phase === "gameOver" ? "重新开场" : "开始下一轮"}
                        </button>
                      ) : (
                        <p>
                          等待房主
                          {v.phase === "gameOver" ? "重新开场" : "开始下一轮"}
                        </p>
                      )}
                      {seconds(v.nextRoundAt) > 0 && (
                        <span>再看 {seconds(v.nextRoundAt)} 秒</span>
                      )}
                    </div>
                  </section>
                ) : (
                  <div className="game-layout">
                    <section className="opponents">
                      <div className="section-label">
                        桌上的朋友 <span>按位置记忆，不显示暗牌点数</span>
                      </div>
                      <div className="opponent-tabs">
                        {v.players
                          .filter((p) => p.id !== v.selfId)
                          .map((p) => (
                            <button
                              key={p.id}
                              className={target === p.id ? "active" : ""}
                              onClick={() => {
                                setTarget(p.id);
                                setSkillIndex(undefined);
                              }}
                            >
                              {p.name} · {p.hand.length} 张
                            </button>
                          ))}
                      </div>
                      {v.players
                        .filter((p) => p.id !== v.selfId)
                        .map((p, i) => (
                          <article
                            className={`player-area ${target === p.id || (!target && i === 0) ? "mobile-active" : ""} ${v.turnPlayerId === p.id ? "active-player" : ""}`}
                            key={p.id}
                          >
                            <div className="player-title">
                              <h2>{p.name}</h2>
                              <span>
                                {p.connected ? "在线" : "暂时离线"} ·{" "}
                                {p.hand.length} 张
                              </span>
                            </div>
                            {hand(p)}
                          </article>
                        ))}
                    </section>
                    <section className="table-center">
                      <div className="piles">
                        <div className="pile">
                          <img src="/cards/back.svg" alt="摸牌堆" />
                          <span>
                            摸牌堆 <b>{v.deckCount}</b>
                          </span>
                        </div>
                        <div className="pile">
                          {v.discardTop ? (
                            <img
                              src={faceUrl(v.discardTop)}
                              alt={`弃牌堆 ${cardName(v.discardTop)}`}
                            />
                          ) : (
                            <div className="empty-card">空</div>
                          )}
                          <span>弃牌堆</span>
                        </div>
                      </div>
                      <p className="table-motto">留住低分，藏好秘密。</p>
                    </section>
                    <section className="my-area">
                      <div className="player-title">
                        <h2>
                          我的手牌 <span>{mine?.name}</span>
                        </h2>
                        <span>{mine?.hand.length} 张 · 位置从左至右</span>
                      </div>
                      {swapMessage && (
                        <p className="swap-feedback" role="status">
                          {swapMessage}
                        </p>
                      )}
                      {mine && hand(mine, true)}
                    </section>
                    <section className="action-area" aria-label="回合操作">
                      {v.phase === "initial" ? (
                        <>
                          <h2>
                            {v.initial?.status === "selecting"
                              ? "选两张牌，记住它们。"
                              : v.initial?.status === "done"
                                ? "记住了，就等朋友准备好。"
                                : "正在私密查看"}
                          </h2>
                          <p>
                            30 秒内选牌，最多查看 10 秒；盖回后不再保留提示。
                          </p>
                          {initialPicking && (
                            <button
                              className="primary"
                              disabled={locked || selected.length !== 2}
                              onClick={() =>
                                void send({
                                  type: "initialSelect",
                                  indices: selected,
                                })
                              }
                            >
                              查看选中的两张牌
                            </button>
                          )}
                          {v.initial?.status === "done" && (
                            <span className="tag">
                              已完成 {v.initial.doneIds.length} /{" "}
                              {v.players.length}
                            </span>
                          )}
                        </>
                      ) : !myTurn ? (
                        <>
                          <h2>看看牌桌，想好下一步。</h2>
                          <p>
                            等待{" "}
                            {
                              v.players.find((p) => p.id === v.turnPlayerId)
                                ?.name
                            }{" "}
                            行动。超时会自动弃牌。
                          </p>
                        </>
                      ) : reveal ? (
                        <h2>记住牌面后，盖回结束回合。</h2>
                      ) : !v.pending ? (
                        <>
                          <h2>拿一张牌，或呼唤 CABO。</h2>
                          <div className="button-row">
                            <button
                              className="primary"
                              disabled={locked || !acting}
                              onClick={() =>
                                void perform({ type: "draw", source: "deck" })
                              }
                            >
                              <Icon name="draw" />
                              摸一张牌
                            </button>
                            <button
                              className="secondary"
                              disabled={locked || !acting || !v.discardTop}
                              onClick={() =>
                                void perform({
                                  type: "draw",
                                  source: "discard",
                                })
                              }
                            >
                              <Icon name="discard" />
                              取弃牌堆
                            </button>
                            <button
                              className="cabo-button"
                              disabled={locked || !acting || !!v.caboCallerId}
                              onClick={() => setConfirm("cabo")}
                            >
                              呼唤 CABO
                            </button>
                          </div>
                        </>
                      ) : (
                        <div className="pending-actions">
                          <div className="pending" data-testid="pending-card">
                            <img
                              src={faceUrl(v.pending.card)}
                              alt={`摸到 ${cardName(v.pending.card)}`}
                            />
                            <span>
                              仅你可见 ·{" "}
                              {v.pending.source === "deck"
                                ? "摸牌堆"
                                : "弃牌堆"}
                            </span>
                          </div>
                          <div className="pending-controls">
                            <h2>
                              {mode === "swap"
                                ? "选择要换掉的位置"
                                : mode === "skill"
                                  ? rank <= 8
                                    ? "选择自己的一张牌"
                                    : rank <= 10
                                      ? "选择对手与一个位置"
                                      : "选择两名玩家各一张牌"
                                  : "这张牌，怎么用？"}
                            </h2>
                            {!mode ? (
                              <div className="button-row">
                                <button
                                  className="secondary"
                                  disabled={locked || !acting}
                                  onClick={() =>
                                    void perform({ type: "discard" })
                                  }
                                >
                                  直接弃置
                                </button>
                                <button
                                  className="primary"
                                  disabled={locked || !acting}
                                  onClick={() => {
                                    setMode("swap");
                                    setSelected([]);
                                  }}
                                >
                                  换入手牌
                                </button>
                                {skillPossible && (
                                  <button
                                    className="secondary"
                                    disabled={locked || !acting}
                                    onClick={beginSkill}
                                  >
                                    使用技能
                                  </button>
                                )}
                              </div>
                            ) : (
                              <>
                                {mode === "swap" ? (
                                  <p>
                                    已选 {selected.length}{" "}
                                    张。多张必须同点数，否则公开并加一张。
                                  </p>
                                ) : (
                                  <>
                                    <p>
                                      {rank <= 10
                                        ? "查看最多 5 秒；只有你能看到。"
                                        : "选择两名不同玩家各一张牌，序号不限；可选自己或两名对手，交换不揭示暗牌。"}
                                    </p>
                                    {exchanging && (
                                      <p
                                        data-testid="exchange-selection"
                                        aria-live="polite"
                                      >
                                        已选 {exchangeCards.length}/2：
                                        {exchangeCards.length
                                          ? exchangeCards
                                              .map(
                                                (card) =>
                                                  `${v.players.find((p) => p.id === card.playerId)?.name} · 第 ${card.index + 1} 张`,
                                              )
                                              .join(" ↔ ")
                                          : "请点击牌面选择"}
                                        。再次点击可取消。
                                      </p>
                                    )}
                                    {rank >= 9 && rank <= 10 && (
                                      <div className="target-buttons">
                                        {v.players
                                          .filter((p) => p.id !== v.selfId)
                                          .map((p) => (
                                            <button
                                              key={p.id}
                                              className={
                                                target === p.id ? "active" : ""
                                              }
                                              disabled={locked}
                                              onClick={() => {
                                                setTarget(p.id);
                                                setSkillIndex(undefined);
                                              }}
                                            >
                                              {p.name}
                                            </button>
                                          ))}
                                      </div>
                                    )}
                                  </>
                                )}
                                <div className="button-row">
                                  <button
                                    className="primary"
                                    disabled={
                                      locked ||
                                      !acting ||
                                      (mode === "swap"
                                        ? selected.length === 0
                                        : exchanging
                                          ? exchangeCards.length !== 2
                                          : skillIndex === undefined ||
                                            !targetId)
                                    }
                                    onClick={() =>
                                      void perform(
                                        mode === "swap"
                                          ? { type: "swap", indices: selected }
                                          : exchanging
                                            ? {
                                                type: "exchange",
                                                first: exchangeCards[0],
                                                second: exchangeCards[1],
                                              }
                                            : {
                                                type: "skill",
                                                targetId: targetId!,
                                                index: skillIndex!,
                                              },
                                      )
                                    }
                                  >
                                    {mode === "swap" ? "确认交换" : "确认技能"}
                                  </button>
                                  <button
                                    className="text-button"
                                    disabled={locked}
                                    onClick={() => {
                                      setMode(undefined);
                                      setSelected([]);
                                      setSkillIndex(undefined);
                                      setExchangeCards([]);
                                    }}
                                  >
                                    取消
                                  </button>
                                </div>
                              </>
                            )}
                          </div>
                        </div>
                      )}
                    </section>
                  </div>
                )}
                <div className="below-table">
                  <details className="activity">
                    <summary>牌桌动态</summary>
                    <ol>
                      {v.logs
                        .slice(-10)
                        .reverse()
                        .map((l) => (
                          <li key={l.id}>{l.text}</li>
                        ))}
                    </ol>
                  </details>
                  {host && (
                    <button
                      className="text-button danger"
                      onClick={() => setConfirm("endGame")}
                      disabled={locked}
                    >
                      结束整场
                    </button>
                  )}
                </div>
              </>
            )}
          </>
        )}
        {error && (
          <div role="alert" className="error">
            {error}
          </div>
        )}
        {!connected && v && (
          <div className="disconnect-banner" role="status">
            连接已断开，计时仍继续。
            <button onClick={room.reconnect}>重新连接</button>
          </div>
        )}
        <Rules />
      </main>
      <footer>
        <span>CABO</span> 好的记忆，也需要一点冒险。
        <small>同桌 · 同网 · 同乐</small>
      </footer>
      {reveal && (
        <div className="overlay">
          <section
            className="modal private"
            role="dialog"
            aria-modal="true"
            aria-label="私密查看"
          >
            <div className="eyebrow">FOR YOUR EYES ONLY</div>
            <h2>记住位置，藏好秘密。</h2>
            <p>仅你可见 · {seconds(reveal.deadline)} 秒后自动盖回</p>
            <div className="reveal-cards">
              {reveal.cards.map((c) => (
                <div key={`${c.playerId}-${c.index}`}>
                  <img src={faceUrl(c.card)} alt={cardName(c.card)} />
                  <b>
                    {c.playerId === v?.selfId
                      ? "自己"
                      : v?.players.find((p) => p.id === c.playerId)?.name}{" "}
                    · 第 {c.index + 1} 张
                  </b>
                </div>
              ))}
            </div>
            <button
              autoFocus
              className="primary"
              disabled={locked}
              onClick={() => void perform({ type: "closeReveal" })}
            >
              记住了，盖回
            </button>
          </section>
        </div>
      )}
      {confirm && (
        <div className="overlay">
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label={confirm === "cabo" ? "确认 CABO" : "确认结束游戏"}
          >
            <h2>
              {confirm === "cabo" ? "准备好呼唤 CABO？" : "结束这一场游戏？"}
            </h2>
            <p>
              {confirm === "cabo"
                ? "这会占用你的整个回合。其他玩家各行动一次后结算；并列最低得 0，否则你的牌分翻倍。"
                : "当前手牌和本场积分将清空，所有玩家返回大厅。"}
            </p>
            <div className="button-row">
              <button
                autoFocus
                className="secondary"
                onClick={() => setConfirm(undefined)}
              >
                再想想
              </button>
              <button
                className="primary"
                disabled={locked}
                onClick={() =>
                  void perform(
                    confirm === "cabo"
                      ? { type: "cabo" }
                      : { type: "endGame", confirm: true },
                  )
                }
              >
                {confirm === "cabo" ? "确认呼唤 CABO" : "确认结束并返回大厅"}
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
