import { enterFirstRoom } from "../support/browser";
import { test, expect, type Page } from "@playwright/test";

async function opening(page: Page) {
  await page
    .getByRole("button", { name: "我的牌 第 1 张", exact: true })
    .click();
  await page
    .getByRole("button", { name: "我的牌 第 2 张", exact: true })
    .click();
  await page
    .getByRole("button", { name: "查看选中的两张牌", exact: true })
    .click();
  await page.getByRole("button", { name: "记住了，盖回", exact: true }).click();
}

for (const count of [2, 3, 4]) {
  test(`CABO notice persists for ${count} players through scrolling and reconnect`, async ({
    page,
    browser,
    request,
  }) => {
    // Covers two full openings, reconnect, settlement cooldown and context cleanup.
    test.setTimeout(240000);
    await request.post("/__test/reset");
    const contexts = [];
    const players = [page];
    for (let i = 1; i < count; i++) {
      const context = await browser.newContext({
        viewport: page.viewportSize() ?? undefined,
      });
      contexts.push(context);
      players.push(await context.newPage());
    }
    const starter = Math.floor(0.31 * count);
    const caller = players[starter];
    const callerName = "记性特别好的森林小伙伴今天也来玩牌";
    const names = players.map((_, i) =>
      i === starter ? callerName : `玩家${i + 1}`,
    );
    for (const [i, p] of players.entries()) {
      await p.goto("/");
      await p.getByLabel("你的昵称").fill(names[i]);
      await enterFirstRoom(p);
      await p.getByRole("button", { name: "准备", exact: true }).click();
    }
    await page.getByRole("button", { name: "开始游戏", exact: true }).click();
    for (const p of players) await opening(p);
    for (const p of players)
      await expect(p.getByTestId("cabo-notice")).toHaveCount(0);
    await caller
      .getByRole("button", { name: "呼唤 CABO", exact: true })
      .click();
    await caller
      .getByRole("button", { name: "确认呼唤 CABO", exact: true })
      .click();
    for (const p of players) {
      await expect(p.getByTestId("cabo-notice")).toContainText(
        `${callerName} 已呼唤 CABO`,
      );
      await expect(p.getByTestId("cabo-notice")).toContainText(
        `剩余 ${count - 1} 人行动`,
      );
      await p.evaluate(() =>
        window.scrollTo(0, document.documentElement.scrollHeight),
      );
      await expect
        .poll(async () => {
          const box = await p.getByTestId("cabo-notice").boundingBox();
          return (
            !!box &&
            box.y >= 0 &&
            box.y + box.height <= (p.viewportSize()?.height ?? 0)
          );
        })
        .toBe(true);
      expect(
        await p.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    }
    await caller.context().setOffline(true);
    await request.post("/__test/drop-connections");
    await expect(caller.locator(".disconnect-banner")).toBeVisible();
    await expect(caller.getByTestId("cabo-notice")).toContainText(callerName);
    await caller.context().setOffline(false);
    for (const p of players)
      await expect(p.locator(".connection")).toContainText("已连接", {
        timeout: 25000,
      });
    await expect(caller.getByTestId("cabo-notice")).toContainText(
      `剩余 ${count - 1} 人行动`,
    );
    await caller.reload();
    await expect(caller.locator(".connection")).toContainText("已连接");
    await expect(caller.getByTestId("cabo-notice")).toContainText(
      `剩余 ${count - 1} 人行动`,
    );

    for (let step = 1; step < count; step++) {
      const actor = players[(starter + step) % count];
      await expect(
        actor.getByRole("heading", {
          name: "最后行动阶段，请摸牌或取弃牌堆。",
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        actor.getByRole("button", { name: "已有玩家呼唤 CABO", exact: true }),
      ).toBeDisabled();
      if (step === 1) await request.post("/__test/skill?rank=7");
      await actor
        .getByRole("button", { name: "摸一张牌", exact: true })
        .click();
      if (step === 1) {
        await actor
          .getByRole("button", { name: "使用技能", exact: true })
          .click();
        await actor
          .getByRole("button", { name: "我的牌 第 1 张", exact: true })
          .click();
        await actor
          .getByRole("button", { name: "确认技能", exact: true })
          .click();
        await expect(caller.getByTestId("skill-notice")).toContainText(
          "发动了偷看技能",
        );
        await caller.evaluate(() => window.scrollTo(0, 0));
        await expect
          .poll(async () => {
            const cabo = await caller.getByTestId("cabo-notice").boundingBox();
            const skill = await caller
              .getByTestId("skill-notice")
              .boundingBox();
            const stack = await caller
              .getByTestId("table-notices")
              .boundingBox();
            const header = await caller.locator(".topbar").boundingBox();
            return (
              !!cabo &&
              !!skill &&
              !!stack &&
              !!header &&
              cabo.y + cabo.height <= skill.y &&
              stack.y + stack.height <= header.y + 1
            );
          })
          .toBe(true);
        await caller.screenshot({
          path: `artifacts/cabo-${count}-${test.info().project.name}.png`,
          fullPage: true,
        });
        // Let the real five-second reveal expire; screenshots can outlive it.
      } else
        await actor
          .getByRole("button", { name: "直接弃置", exact: true })
          .click();
      for (const p of players) {
        if (step < count - 1)
          await expect(p.getByTestId("cabo-notice")).toContainText(
            `剩余 ${count - 1 - step} 人行动`,
          );
        else await expect(p.getByTestId("cabo-notice")).toHaveCount(0);
      }
    }
    const host = (
      await Promise.all(
        players.map(async (p) =>
          (await p
            .getByRole("button", { name: "开始下一轮", exact: true })
            .count())
            ? p
            : undefined,
        ),
      )
    ).find((p) => p)!;
    expect(host).toBeDefined();
    await host
      .getByRole("button", { name: "开始下一轮", exact: true })
      .click({ timeout: 12000 });
    for (const p of players)
      await expect(p.getByTestId("cabo-notice")).toHaveCount(0);
    for (const p of players) await opening(p);
    const nextCaller = players[(starter + 1) % count];
    await nextCaller
      .getByRole("button", { name: "呼唤 CABO", exact: true })
      .click();
    await nextCaller
      .getByRole("button", { name: "确认呼唤 CABO", exact: true })
      .click();
    for (const p of players)
      await expect(p.getByTestId("cabo-notice")).toBeVisible();
    await host.getByRole("button", { name: "结束整场", exact: true }).click();
    await host
      .getByRole("button", { name: "确认结束并返回大厅", exact: true })
      .click();
    for (const p of players)
      await expect(p.getByTestId("cabo-notice")).toHaveCount(0);
    await Promise.all(contexts.map((context) => context.close()));
  });
}
