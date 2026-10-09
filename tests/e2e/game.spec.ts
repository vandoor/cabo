import { test, expect, type Page, type Browser } from "@playwright/test";
test.beforeEach(async ({ request }) => {
  await request.post("/__test/reset");
});
async function join(page: Page, name: string) {
  await page.goto("/");
  await page.getByLabel("你的昵称").fill(name);
  await page.getByRole("button", { name: "入座" }).click();
  await expect(
    page.getByRole("button", { name: "准备", exact: true }),
  ).toBeVisible();
}
async function opening(page: Page) {
  await page.getByRole("button", { name: "我的牌 第 1 张" }).click();
  await page.getByRole("button", { name: "我的牌 第 2 张" }).click();
  await page.getByRole("button", { name: "查看选中的两张牌" }).click();
  await expect(page.getByRole("dialog", { name: "私密查看" })).toBeVisible();
  await page.getByRole("button", { name: "记住了，盖回" }).click();
}
async function setup(page: Page, browser: Browser) {
  const ctx = await browser.newContext({
    viewport: page.viewportSize() ?? undefined,
  });
  const other = await ctx.newPage();
  await join(page, "小鹿");
  await join(other, "小熊");
  await page.getByRole("button", { name: "准备", exact: true }).click();
  await other.getByRole("button", { name: "准备", exact: true }).click();
  await page.getByRole("button", { name: "开始游戏", exact: true }).click();
  await opening(page);
  await opening(other);
  return { other, ctx };
}
async function end(page: Page) {
  await page.getByRole("button", { name: "结束整场" }).click();
  await page.getByRole("button", { name: "确认结束并返回大厅" }).click();
  await page.getByRole("button", { name: "离开房间" }).click();
}
test("two browsers play CABO, reveal scores, and start the rotated next round", async ({
  page,
  browser,
}) => {
  const { other, ctx } = await setup(page, browser);
  await expect(page.getByRole("button", { name: "呼唤 CABO" })).toBeEnabled();
  await page.getByRole("button", { name: "呼唤 CABO" }).click();
  await page.getByRole("button", { name: "确认呼唤 CABO" }).click();
  await other.getByRole("button", { name: "摸一张牌" }).click();
  await expect(other.getByTestId("pending-card")).toBeVisible();
  await expect(page.getByTestId("pending-card")).toHaveCount(0);
  await other.reload();
  await expect(other.getByTestId("pending-card")).toBeVisible();
  await other.getByRole("button", { name: "直接弃置" }).click();
  await expect(
    page.getByRole("heading", { name: "本轮结算", level: 1 }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "开始下一轮" })).toBeEnabled({
    timeout: 12000,
  });
  await page.getByRole("button", { name: "开始下一轮" }).click();
  await opening(page);
  await opening(other);
  await expect(other.getByRole("button", { name: "摸一张牌" })).toBeEnabled();
  await end(page);
  await other.getByRole("button", { name: "离开房间" }).click();
  await ctx.close();
});
test("private skill overlay, failed multi-swap, numbered extra cards, responsive layout", async ({
  page,
  browser,
  request,
}) => {
  const { other, ctx } = await setup(page, browser);
  await request.post("/__test/skill");
  await page.getByRole("button", { name: "摸一张牌" }).click();
  await page.getByRole("button", { name: "使用技能" }).click();
  await page.getByRole("button", { name: "我的牌 第 3 张" }).click();
  await page.getByRole("button", { name: "确认技能" }).click();
  await expect(page.getByRole("dialog", { name: "私密查看" })).toBeVisible();
  await expect(other.getByRole("dialog", { name: "私密查看" })).toHaveCount(0);
  await expect(other.getByTestId("skill-notice")).toHaveText(
    "小鹿 发动了偷看技能",
  );
  await expect(page.getByTestId("skill-notice")).toHaveCount(0);
  await page.getByRole("button", { name: "记住了，盖回" }).click();
  await other.getByRole("button", { name: "摸一张牌" }).click();
  await other.getByRole("button", { name: "换入手牌" }).click();
  for (let i = 1; i <= 4; i++)
    await other.getByRole("button", { name: `我的牌 第 ${i} 张` }).click();
  await other.getByRole("button", { name: "确认交换" }).click();
  await expect(
    other.getByRole("button", { name: "我的牌 第 5 张" }),
  ).toBeVisible();
  await expectSwapFeedback(other, page, 5, "合并失败，新牌追加到第 5 张");
  await other.screenshot({
    path: `artifacts/swap-failed-${test.info().project.name}.png`,
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  expect(
    await other.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: `artifacts/table-${test.info().project.name}.png`,
    fullPage: true,
  });
  await end(page);
  await other.getByRole("button", { name: "离开房间" }).click();
  await ctx.close();
});

async function swap(page: Page, positions: number[]) {
  await page.getByRole("button", { name: "摸一张牌" }).click();
  await page.getByRole("button", { name: "换入手牌" }).click();
  for (const position of positions)
    await page
      .getByRole("button", { name: `我的牌 第 ${position} 张` })
      .click();
  await page.getByRole("button", { name: "确认交换" }).click();
}

async function expectSwapFeedback(
  page: Page,
  other: Page,
  position: number,
  message: string,
) {
  const incoming = page.getByRole("button", {
    name: `我的牌 第 ${position} 张`,
  });
  await expect(page.locator(".my-area [role=status]")).toHaveText(message);
  await expect(page.locator(".card-slot.new-card")).toHaveCount(1);
  await expect(incoming).toHaveClass(/new-card/);
  await expect(incoming.getByText("新换入", { exact: true })).toBeVisible();
  await expect(incoming.locator("img")).toHaveAttribute(
    "src",
    "/cards/back.svg",
  );
  await expect(incoming.locator("img")).toHaveAttribute("alt", "暗牌");
  await expect(other.locator(".card-slot.new-card")).toHaveCount(0);
  await expect(other.getByText("新换入", { exact: true })).toHaveCount(0);
  await expect(other.locator(".my-area [role=status]")).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
}

test("single swap highlights only the incoming back and refresh preserves remaining time", async ({
  page,
  browser,
}) => {
  const { other, ctx } = await setup(page, browser);
  await swap(page, [2]);
  await expectSwapFeedback(page, other, 2, "换牌成功，新牌放在第 2 张");
  const incoming = page.locator(".card-slot.new-card img");
  await expect(incoming).toHaveCSS("animation-name", "card-arrive");
  for (const card of await page
    .locator(".card-slot:not(.new-card), .card-slot:not(.new-card) img")
    .all())
    await expect(card).toHaveCSS("animation-name", "none");
  // A regular broadcast must neither remount the hand nor restart emphasis.
  await incoming.evaluate((el) => el.setAttribute("data-retained", "yes"));
  await other.getByRole("button", { name: "摸一张牌" }).click();
  await expect(incoming).toHaveAttribute("data-retained", "yes");
  await page.screenshot({
    path: `artifacts/swap-single-${test.info().project.name}.png`,
    fullPage: true,
  });
  await page.waitForTimeout(2500);
  await page.reload();
  await expect(page.getByText("新换入", { exact: true })).toBeVisible();
  // The client must also expire the hint without receiving another state update.
  await page.context().setOffline(true);
  await expect(page.getByText("新换入", { exact: true })).toHaveCount(0, {
    timeout: 2800,
  });
  await expect(page.locator(".my-area [role=status]")).toHaveCount(0);
  await expect(page.locator(".card-slot.new-card")).toHaveCount(0);
  await page.context().setOffline(false);
  // Start a fresh connection for cleanup: WebKit's offline transport can still
  // be waiting for Socket.IO's connection timeout after the network is restored.
  await page.reload();
  await expect(page.locator(".connection")).toContainText("已连接");
  await expect(page.getByText("新换入", { exact: true })).toHaveCount(0);
  await end(other);
  await page.getByRole("button", { name: "离开房间" }).click();
  await ctx.close();
});

test("compacted merge highlights position two with reduced motion and clears when a skill moves it", async ({
  page,
  browser,
  request,
}) => {
  const { other, ctx } = await setup(page, browser);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await request.post("/__test/merge");
  await swap(page, [4, 2]);
  await expect(page.locator(".my-area .card-slot")).toHaveCount(3);
  await expectSwapFeedback(page, other, 2, "合并成功，新牌放在第 2 张");
  await expect(page.locator(".card-slot.new-card img")).toHaveCSS(
    "animation-name",
    "none",
  );
  await expect(page.locator(".card-slot.new-card img")).toHaveCSS(
    "border-top-color",
    "rgb(245, 216, 142)",
  );
  await page.screenshot({
    path: `artifacts/swap-merge-${test.info().project.name}.png`,
    fullPage: true,
  });
  await request.post("/__test/skill?rank=11");
  await other.getByRole("button", { name: "摸一张牌" }).click();
  await other.getByRole("button", { name: "使用技能" }).click();
  await other.getByRole("button", { name: "我的牌 第 4 张" }).click();
  await other.getByRole("button", { name: "小鹿的牌 第 2 张" }).click();
  await expect(page.getByText("新换入", { exact: true })).toBeVisible();
  await other.getByRole("button", { name: "确认技能" }).click();
  await expect(page.getByText("新换入", { exact: true })).toHaveCount(0);
  await expect(page.locator(".my-area [role=status]")).toHaveCount(0);
  await end(page);
  await ctx.close();
});

test("spy, independent-position exchange, game over and a clean restart", async ({
  page,
  browser,
  request,
}) => {
  const { other, ctx } = await setup(page, browser);
  await request.post("/__test/skill?rank=9");
  await page.getByRole("button", { name: "摸一张牌" }).click();
  await page.getByRole("button", { name: "使用技能" }).click();
  await page.getByRole("button", { name: "小熊的牌 第 2 张" }).click();
  await page.getByRole("button", { name: "确认技能" }).click();
  await expect(page.getByRole("dialog", { name: "私密查看" })).toContainText(
    "小熊 · 第 2 张",
  );
  await expect(other.getByTestId("skill-notice")).toHaveText(
    "小鹿 发动了间谍技能",
  );
  await page.getByRole("button", { name: "记住了，盖回" }).click();
  await request.post("/__test/skill?rank=11");
  await other.getByRole("button", { name: "摸一张牌" }).click();
  await other.getByRole("button", { name: "使用技能" }).click();
  await other.getByRole("button", { name: "我的牌 第 4 张" }).click();
  await other.getByRole("button", { name: "小鹿的牌 第 2 张" }).click();
  await other.getByRole("button", { name: "确认技能" }).click();
  await expect(page.getByRole("button", { name: "摸一张牌" })).toBeEnabled();
  await request.post("/__test/final");
  await page.getByRole("button", { name: "呼唤 CABO" }).click();
  await page.getByRole("button", { name: "确认呼唤 CABO" }).click();
  await other.getByRole("button", { name: "摸一张牌" }).click();
  await other.getByRole("button", { name: "直接弃置" }).click();
  await expect(page.getByRole("heading", { name: "本场赢家" })).toBeVisible();
  await expect(page.getByRole("button", { name: "重新开场" })).toBeEnabled({
    timeout: 12000,
  });
  await page.getByRole("button", { name: "重新开场" }).click();
  await expect(page.getByRole("heading", { name: "记住你的牌" })).toBeVisible();
  await expect(page.locator(".score-strip b")).toHaveText(["0 分", "0 分"]);
  await end(page);
  await other.getByRole("button", { name: "离开房间" }).click();
  await ctx.close();
});

test("a rejected partial opening selection returns to the server accepted positions", async ({
  page,
  browser,
  request,
}) => {
  const ctx = await browser.newContext();
  const other = await ctx.newPage();
  await join(page, "小鹿");
  await join(other, "小熊");
  await page.getByRole("button", { name: "准备", exact: true }).click();
  await other.getByRole("button", { name: "准备", exact: true }).click();
  await page.getByRole("button", { name: "开始游戏", exact: true }).click();
  await request.post("/__test/reject-partial");
  const card = page.getByRole("button", { name: "我的牌 第 4 张" });
  await card.click();
  await expect(page.getByRole("alert")).toContainText("牌局已更新");
  await expect(card).toHaveAttribute("aria-pressed", "false");
  await card.click();
  await expect(card).toHaveAttribute("aria-pressed", "true");
  await page.reload();
  await expect(card).toHaveAttribute("aria-pressed", "true");
  await end(other);
  await page.getByRole("button", { name: "离开房间" }).click();
  await ctx.close();
});
