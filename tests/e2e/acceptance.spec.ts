import { test, expect, type Page } from "@playwright/test";
import { io, type Socket } from "socket.io-client";
import { randomBytes, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import type { GameCommand } from "../../packages/game/src/types";
test("one-minute two rooms, secure recovery, exchange notices and mobile layouts", async ({
  page,
  browser,
  request,
}) => {
  mkdirSync("artifacts/acceptance", { recursive: true });
  const rows: any[] = [];
  const collect = (p: Page) =>
    p.on("console", (msg) => {
      if (msg.text().startsWith("[cabo-timing] ")) {
        const row = JSON.parse(msg.text().slice(14));
        rows.push(row);
        appendFileSync(
          "artifacts/acceptance/client.jsonl",
          JSON.stringify(row) + "\n",
        );
      }
    });
  collect(page);
  const clients: Socket[] = [];
  async function peer(name: string, roomId?: string) {
    const s = io("http://127.0.0.1:3100", {
      transports: ["websocket"],
      forceNew: true,
    });
    clients.push(s);
    await new Promise<void>((r) => s.once("connect", r));
    const id = {
      browserId: randomUUID(),
      secret: randomBytes(32).toString("hex"),
    };
    const q = await s
      .timeout(2000)
      .emitWithAck("session", { ...id, requestId: randomUUID() });
    const a = await s.timeout(2000).emitWithAck(roomId ? "join" : "create", {
      ...id,
      serverId: q.serverId,
      generation: q.session.generation,
      requestId: randomUUID(),
      roomId,
      name,
      roomName: "第二间",
    });
    expect(a.ok, JSON.stringify(a.error)).toBe(true);
    const scope = {
      serverId: a.serverId,
      generation: a.session.generation,
      roomId: a.view.roomId,
    };
    return {
      s,
      roomId: a.view.roomId,
      async command(command: GameCommand) {
        const v = (
          await s
            .timeout(2000)
            .emitWithAck("sync", { ...scope, requestId: randomUUID() })
        ).view;
        const a = await s.timeout(2000).emitWithAck("command", {
          ...scope,
          requestId: randomUUID(),
          version: v.version,
          command,
        });
        expect(a.ok, JSON.stringify(a.error)).toBe(true);
        return a;
      },
    };
  }
  const click = (name: string) =>
    page.getByRole("button", { name, exact: true }).click();
  const step = async (name: string, fn: () => Promise<void>) =>
    test.step(name, async () => {
      console.log("[acceptance-step] " + name);
      const start = performance.now();
      try {
        await fn();
      } finally {
        appendFileSync(
          "artifacts/acceptance/steps.jsonl",
          JSON.stringify({
            step: name,
            phase: "flow",
            durationMs: performance.now() - start,
          }) + "\n",
        );
      }
    });
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  const watch = await ctx.newPage();
  collect(watch);
  try {
    await request.post("/__test/reset");
    let firstRoom = "";
    let peers: Awaited<ReturnType<typeof peer>>[] = [];
    let second: Awaited<ReturnType<typeof peer>>;
    await step("create and join two independent rooms", async () => {
      await page.goto("/");
      await page.getByLabel("你的昵称").fill("验收玩家");
      await page.getByLabel("房间名称（可选）").fill("第一间");
      await click("创建房间");
      await expect(
        page.getByRole("button", { name: "准备", exact: true }),
      ).toBeVisible();
      firstRoom = new URL(page.url()).searchParams.get("room")!;
      peers = [await peer("小熊", firstRoom), await peer("小狐", firstRoom)];
      second = await peer("第二间房主");
      await watch.goto("/");
      await expect(watch.getByTestId("room-summary")).toHaveCount(2);
      await watch.getByLabel("你的昵称").fill("第二间玩家");
      await watch
        .getByTestId("room-summary")
        .filter({
          has: watch.getByRole("heading", { name: "第二间", exact: true }),
        })
        .getByRole("button", { name: "加入", exact: true })
        .click();
      await expect(
        watch.getByRole("button", { name: "准备", exact: true }),
      ).toBeVisible();
      await watch.getByRole("button", { name: "返回房间列表" }).click();
      await expect(
        watch.getByRole("button", { name: "返回我的牌局" }),
      ).toHaveCount(0);
      await watch
        .getByTestId("room-summary")
        .filter({
          has: watch.getByRole("heading", { name: "第一间", exact: true }),
        })
        .getByRole("button", { name: "观战", exact: true })
        .click();
      await expect(
        watch.getByRole("button", { name: "退出观战" }),
      ).toBeVisible();
    });
    await step(
      "start and restore opening without extending deadline",
      async () => {
        for (const p of peers) await p.command({ type: "ready", ready: true });
        await click("准备");
        await click("开始游戏");
        for (const p of peers) {
          await p.command({ type: "initialSelect", indices: [0, 1] });
          await p.command({ type: "closeReveal" });
        }
        await click("我的牌 第 1 张");
        await click("我的牌 第 2 张");
        await click("查看选中的两张牌");
        await expect(
          page.getByRole("dialog", { name: "私密查看" }),
        ).toBeVisible();
        await page.reload();
        await expect(
          page.getByRole("dialog", { name: "私密查看" }),
        ).toBeVisible();
        await click("记住了，盖回");
        await expect(watch.getByRole("dialog")).toHaveCount(0);
      },
    );
    await step(
      "reserve active seat while browsing and watching another room",
      async () => {
        await click("返回房间列表");
        await expect(
          page.getByRole("button", { name: "返回我的牌局" }),
        ).toBeVisible();
        await page
          .getByTestId("room-summary")
          .filter({
            has: page.getByRole("heading", { name: "第二间", exact: true }),
          })
          .getByRole("button", { name: "观战", exact: true })
          .click();
        await expect(
          page.getByText("第二间房主", { exact: true }),
        ).toBeVisible();
        await click("退出观战");
        await click("返回我的牌局");
        await expect(
          page.getByRole("button", { name: "摸一张牌", exact: true }),
        ).toBeEnabled();
        await page.goBack();
        await expect(
          page.getByRole("button", { name: "返回我的牌局" }),
        ).toBeVisible();
        await page.goForward();
        await expect(
          page.getByRole("button", { name: "摸一张牌", exact: true }),
        ).toBeEnabled();
      },
    );
    await step(
      "J/Q shows both positions to actor and spectator and refresh retains expiry",
      async () => {
        await request.post("/__test/skill?rank=12");
        await click("摸一张牌");
        await click("使用技能");
        await click("小熊的牌 第 2 张");
        await click("小狐的牌 第 4 张");
        await click("确认技能");
        const text = "验收玩家发动了交换技能：小熊第 2 张 ↔ 小狐第 4 张。";
        await expect(page.getByTestId("skill-notice")).toHaveText(text);
        await expect(watch.getByTestId("skill-notice")).toHaveText(text);
        await watch.reload();
        await expect(watch.getByTestId("skill-notice")).toHaveText(text);
        for (const width of [320, 390]) {
          await watch.setViewportSize({ width, height: 844 });
          expect(
            await watch.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth,
            ),
          ).toBe(true);
          await watch.screenshot({
            path: `artifacts/acceptance/mobile-${width}.png`,
            fullPage: true,
          });
        }
        await page.screenshot({
          path: "artifacts/acceptance/desktop.png",
          fullPage: true,
        });
      },
    );
    await step(
      "public draw and new-card feedback share card assets",
      async () => {
        for (const p of peers) {
          await p.command({ type: "draw", source: "deck" });
          await p.command({ type: "discard" });
        }
        await click("取弃牌堆");
        await expect(watch.getByTestId("public-draw")).toContainText("公开");
        await expect(watch.getByTestId("pending-card")).toHaveCount(0);
        await click("换入手牌");
        await click("我的牌 第 3 张");
        await click("确认交换");
        await expect(page.locator(".swap-feedback")).toContainText("第 3 张");
        await expect(page.locator(".my-area .new-card")).toHaveCount(1);
        for (const p of peers) {
          await p.command({ type: "draw", source: "deck" });
          await p.command({ type: "discard" });
        }
      },
    );
    await step("disconnect recovery, CABO and settlement", async () => {
      await request.post("/__test/drop-connections");
      await expect(
        page.getByRole("button", { name: "摸一张牌", exact: true }),
      ).toBeEnabled();
      // Fixture sockets reconnect but deliberately do not reclaim seats; restore them through the browser-independent test protocol by reloading transport is unnecessary for CABO here.
      await request.post("/__test/cabo-failed");
      await click("呼唤 CABO");
      await click("确认呼唤 CABO");
      // The existing fixture transport IDs remain invalid after a drop; use deterministic server time only for remaining offline turns.
      await request.post("/__test/finish-offline");
      await expect(page.locator(".results")).toBeVisible();
      await expect(watch.locator(".results")).toBeVisible();
      await expect(page.locator(".results")).toContainText(
        "CABO 失败 · 牌分 + 10",
      );
      await watch.setViewportSize({ width: 320, height: 844 });
      expect(
        await watch.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await watch.screenshot({
        path: "artifacts/acceptance/settlement-320.png",
        fullPage: true,
      });
      await click("结束整场");
      await click("确认结束并返回大厅");
      await expect(
        page.getByRole("button", { name: "准备", exact: true }),
      ).toBeVisible();
    });
    await step("host closes room with confirmation", async () => {
      await click("关闭房间");
      await click("确认关闭房间");
      await expect(page.getByTestId("room-summary")).toHaveCount(1);
      await expect(watch.getByTestId("room-summary")).toHaveCount(1);
    });
    await step("safe timing schema", async () => {
      for (const event of [
        "create",
        "join",
        "watch",
        "browse",
        "restore",
        "exchange",
        "closeRoom",
      ])
        expect(rows.some((r) => r.step === event && r.phase === "ack")).toBe(
          true,
        );
      expect(
        rows.every(
          (r) =>
            Object.keys(r).sort().join(",") ===
            ["side", "requestId", "step", "phase", "durationMs", "result"]
              .sort()
              .join(","),
        ),
      ).toBe(true);
    });
  } finally {
    clients.forEach((s) => s.disconnect());
    await ctx.close();
  }
});
