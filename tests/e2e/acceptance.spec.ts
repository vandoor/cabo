import { test, expect } from "@playwright/test";
import { io, type Socket } from "socket.io-client";
import { appendFileSync, mkdirSync } from "node:fs";
import type { GameCommand, RoomView } from "../../packages/game/src/types";

test("one-minute real clicks, public watching and safe operation timings", async ({
  page,
  browser,
  request,
}) => {
  const rows: {
    step: string;
    phase: string;
    requestId: string;
    durationMs: number;
    result: string;
  }[] = [];
  mkdirSync("artifacts/acceptance", { recursive: true });
  function collect(text: string) {
    if (!text.startsWith("[cabo-timing] ")) return;
    const row = JSON.parse(text.slice(14));
    rows.push(row);
    appendFileSync(
      "artifacts/acceptance/client.jsonl",
      JSON.stringify(row) + "\n",
    );
  }
  page.on("console", (msg) => collect(msg.text()));
  await page.addInitScript(() => {
    const original = window.setInterval;
    (window as any).__tablePollingIntervals = 0;
    window.setInterval = ((
      handler: TimerHandler,
      delay?: number,
      ...args: any[]
    ) => {
      if (delay === 100) (window as any).__tablePollingIntervals++;
      return original(handler, delay, ...args);
    }) as typeof window.setInterval;
  });
  const clients: Socket[] = [];
  let seq = 0;
  async function peer(name: string) {
    const s = io("http://127.0.0.1:3100", {
      transports: ["websocket"],
      forceNew: true,
    });
    clients.push(s);
    await new Promise<void>((resolve) => s.once("connect", resolve));
    const a = await s
      .timeout(2000)
      .emitWithAck("join", { name, requestId: `fixture-${++seq}` });
    expect(a.ok).toBe(true);
    return s;
  }
  async function state(s: Socket): Promise<RoomView> {
    return (await s.timeout(2000).emitWithAck("sync")).view;
  }
  async function command(s: Socket, command: GameCommand) {
    const v = await state(s);
    const a = await s.timeout(2000).emitWithAck("command", {
      requestId: `fixture-${++seq}`,
      version: v.version,
      command,
    });
    expect(a.ok, JSON.stringify(a.error)).toBe(true);
    return a;
  }
  async function click(name: string) {
    await page.getByRole("button", { name, exact: true }).click();
  }
  async function step(name: string, action: () => Promise<void>) {
    await test.step(name, async () => {
      console.log(`[acceptance-step] ${name}`);
      const started = performance.now();
      let result = "ok";
      try {
        await action();
      } catch (error) {
        result = "failed";
        throw error;
      } finally {
        appendFileSync(
          "artifacts/acceptance/steps.jsonl",
          JSON.stringify({
            step: name,
            phase: "flow",
            durationMs: performance.now() - started,
            result,
          }) + "\n",
        );
      }
    });
  }
  const watchContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  const watch = await watchContext.newPage();
  watch.on("console", (msg) => collect(msg.text()));
  try {
    await request.post("/__test/reset");
    await step(
      "watch lobby without name and preserve player token",
      async () => {
        await watch.goto("/");
        await watch.evaluate(() =>
          localStorage.setItem("cabo-session", "preserved-test-token"),
        );
        await watch.getByRole("button", { name: "观战", exact: true }).click();
        await expect(
          watch.getByRole("button", { name: "退出观战" }),
        ).toBeVisible();
        await expect(
          watch.getByRole("button", { name: "准备", exact: true }),
        ).toHaveCount(0);
      },
    );
    await step("join ready start and manual opening", async () => {
      await page.goto("/");
      expect(
        await page.evaluate(() => (window as any).__tablePollingIntervals),
      ).toBe(0);
      await page.getByLabel("你的昵称").fill("验收玩家");
      await click("入座");
      const a = await peer("小熊"),
        b = await peer("小狐");
      await command(a, { type: "ready", ready: true });
      await command(b, { type: "ready", ready: true });
      await click("准备");
      await click("开始游戏");
      for (const s of clients) {
        await command(s, { type: "initialSelect", indices: [0, 1] });
        await command(s, { type: "closeReveal" });
      }
      await click("我的牌 第 1 张");
      await click("我的牌 第 2 张");
      await click("查看选中的两张牌");
      await expect(
        page.getByRole("dialog", { name: "私密查看" }),
      ).toBeVisible();
      await click("记住了，盖回");
      await expect(page.getByRole("dialog", { name: "私密查看" })).toHaveCount(
        0,
      );
      await expect(page.getByTestId("deck-count")).toHaveText(
        "摸牌堆剩余 39 张",
      );
      await expect(watch.getByTestId("deck-count")).toHaveText(
        "摸牌堆剩余 39 张",
      );
    });
    async function cycle() {
      for (const s of clients) {
        await command(s, { type: "draw", source: "deck" });
        await command(s, { type: "discard" });
      }
      await expect(
        page.getByRole("button", { name: "摸一张牌", exact: true }),
      ).toBeEnabled();
    }
    await step("draw discard and deck counter", async () => {
      await click("摸一张牌");
      await expect(page.getByTestId("deck-count")).toHaveText(
        "摸牌堆剩余 38 张",
      );
      await expect(watch.getByTestId("pending-card")).toHaveCount(0);
      await expect(watch.getByTestId("public-draw")).toHaveCount(0);
      await click("直接弃置");
      await cycle();
    });
    await step("discard source and single swap", async () => {
      const count = await page.getByTestId("deck-count").textContent();
      const face = await page
        .locator('.pile img[alt^="弃牌堆"]')
        .getAttribute("src");
      await click("取弃牌堆");
      await expect(page.getByTestId("pending-card")).toContainText(
        "所有人可见 · 弃牌堆",
      );
      await expect(page.getByTestId("deck-count")).toHaveText(count!);
      await expect(watch.getByTestId("public-draw")).toContainText(
        "验收玩家 从弃牌堆取牌",
      );
      await expect(
        watch.getByTestId("public-draw").locator("img"),
      ).toHaveAttribute("src", face!);
      await expect(watch.getByTestId("pending-card")).toHaveCount(0);
      await click("换入手牌");
      await click("我的牌 第 3 张");
      await click("确认交换");
      await expect(page.locator(".swap-feedback")).toContainText("第 3 张");
      await expect(
        page
          .getByRole("button", { name: "我的牌 第 3 张", exact: true })
          .locator("img"),
      ).toHaveAttribute("src", face!);
      await expect(
        watch
          .getByRole("button", { name: "验收玩家的牌 第 3 张", exact: true })
          .locator("img"),
      ).toHaveAttribute("src", face!);
      await expect(watch.getByTestId("public-draw")).toHaveCount(0);
      await cycle();
    });
    await step("matching multi swap", async () => {
      expect((await request.post("/__test/merge")).ok()).toBe(true);
      await click("取弃牌堆");
      await click("换入手牌");
      await click("我的牌 第 2 张");
      await click("我的牌 第 4 张");
      await click("确认交换");
      await expect(page.locator(".my-area .card-slot")).toHaveCount(3);
      await expect(page.locator(".swap-feedback")).toContainText("合并成功");
      await expect(
        watch.getByRole("button", {
          name: "验收玩家的牌 第 2 张",
          exact: true,
        }),
      ).toHaveClass(/exposed/);
      await cycle();
    });
    await step(
      "spy public position, spectator refresh and private close",
      async () => {
        await request.post("/__test/skill?rank=9");
        await click("摸一张牌");
        await click("使用技能");
        await click("小熊的牌 第 2 张");
        await click("确认技能");
        await expect(
          page.getByRole("dialog", { name: "私密查看" }),
        ).toBeVisible();
        await expect(watch.getByTestId("skill-notice")).toHaveText(
          "验收玩家查看了小熊的第2张牌",
        );
        await expect(watch.getByRole("dialog")).toHaveCount(0);
        await watch.reload();
        await expect(watch.getByTestId("skill-notice")).toHaveText(
          "验收玩家查看了小熊的第2张牌",
        );
        await click("记住了，盖回");
        await expect(page.getByTestId("skill-notice")).toHaveText(
          "验收玩家查看了小熊的第2张牌",
        );
        await cycle();
      },
    );
    await step(
      "exchange different players and different positions",
      async () => {
        await request.post("/__test/skill?rank=12");
        await click("摸一张牌");
        await click("使用技能");
        await click("小熊的牌 第 2 张");
        await click("小狐的牌 第 4 张");
        await click("确认技能");
        await expect(watch.getByTestId("skill-notice")).toContainText("交换");
        await expect(page.getByTestId("pending-card")).toHaveCount(0);
        await cycle();
      },
    );
    await step("watch privacy and mobile layout", async () => {
      await expect(
        watch.getByRole("button", { name: "退出观战" }),
      ).toBeVisible();
      expect(
        await watch.evaluate(() => localStorage.getItem("cabo-session")),
      ).toBe("preserved-test-token");
      await expect(watch.locator(".score-strip > div")).toHaveCount(3);
      await expect(watch.getByTestId("deck-count")).toHaveText(
        (await page.getByTestId("deck-count").textContent())!,
      );
      await expect(watch.getByRole("button", { name: "结束整场" })).toHaveCount(
        0,
      );
      await expect(watch.locator(".action-area")).toHaveCount(0);
      expect(
        await watch.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    });
    await step("CABO persistent notice and settlement", async () => {
      expect((await request.post("/__test/cabo-failed")).ok()).toBe(true);
      await click("呼唤 CABO");
      await expect(
        page.getByRole("dialog", { name: "确认 CABO", exact: true }),
      ).toContainText("牌分加 10");
      await click("确认呼唤 CABO");
      await expect(watch.getByTestId("cabo-notice")).toContainText(
        "剩余 2 人行动",
      );
      await command(clients[0], { type: "draw", source: "deck" });
      await command(clients[0], { type: "discard" });
      await expect(page.getByTestId("cabo-notice")).toContainText(
        "剩余 1 人行动",
      );
      await command(clients[1], { type: "draw", source: "deck" });
      await command(clients[1], { type: "discard" });
      await expect(page.locator(".results")).toBeVisible();
      await expect(watch.locator(".results")).toBeVisible();
      await expect(
        page.locator(".result").filter({
          has: page.getByRole("heading", { name: "验收玩家", exact: true }),
        }),
      ).toContainText("CABO 失败 · 牌分 + 10");
      await expect(watch.locator(".results")).toContainText(
        "CABO 失败 · 牌分 + 10",
      );
      await expect(
        page.getByRole("button", { name: "开始下一轮", exact: true }),
      ).toBeDisabled();
      await expect(watch.getByTestId("cabo-notice")).toHaveCount(0);
    });
    await step("end match and exit watching", async () => {
      await click("结束整场");
      await click("确认结束并返回大厅");
      await expect(
        page.getByRole("button", { name: "准备", exact: true }),
      ).toBeVisible();
      await watch.getByRole("button", { name: "退出观战" }).click();
      await expect(
        watch.getByRole("button", { name: "观战", exact: true }),
      ).toBeVisible();
      expect(
        await watch.evaluate(() => localStorage.getItem("cabo-session")),
      ).toBe("preserved-test-token");
    });
    expect(
      await page.evaluate(() => (window as any).__tablePollingIntervals),
    ).toBe(0);
    await watch.getByLabel("你的昵称").fill("退出后的新玩家");
    await watch.getByRole("button", { name: "入座", exact: true }).click();
    await expect(
      watch.getByRole("button", { name: "准备", exact: true }),
    ).toBeVisible();
    await step("timing completeness and schema privacy", async () => {
      for (const step of [
        "join",
        "ready",
        "start",
        "initialSelect",
        "draw",
        "discard",
        "swap",
        "skill",
        "exchange",
        "closeReveal",
        "cabo",
        "endGame",
        "watch",
        "unwatch",
      ]) {
        await expect
          .poll(
            () =>
              rows.filter((row) => row.step === step && row.phase === "paint")
                .length,
            { message: `paint timing for ${step}` },
          )
          .toBeGreaterThan(0);
        for (const phase of ["start", "send", "ack", "commit", "paint"])
          expect(
            rows.some((row) => row.step === step && row.phase === phase),
          ).toBe(true);
      }
      expect(
        rows.some((row) => row.step === "select" && row.phase === "commit"),
      ).toBe(true);
      expect(
        rows.every(
          (row) =>
            Object.keys(row).sort().join(",") ===
              ["side", "requestId", "step", "phase", "durationMs", "result"]
                .sort()
                .join(",") &&
            Number.isFinite(row.durationMs) &&
            row.durationMs >= 0,
        ),
      ).toBe(true);
    });
  } finally {
    clients.forEach((s) => s.disconnect());
    await watchContext.close();
  }
});
