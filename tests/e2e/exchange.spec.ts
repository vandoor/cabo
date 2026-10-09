import { test, expect, type Page } from "@playwright/test";

async function join(page: Page, name: string) {
  await page.goto("/");
  await page.getByLabel("你的昵称").fill(name);
  await page.getByRole("button", { name: "入座", exact: true }).click();
  await page.getByRole("button", { name: "准备", exact: true }).click();
}
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

test("J/Q selects two opponents at independent positions and announces the skill", async ({
  page,
  browser,
  request,
}) => {
  await request.post("/__test/reset");
  const ctx = await browser.newContext({
    viewport: page.viewportSize() ?? undefined,
  });
  const other = await ctx.newPage();
  const thirdCtx = await browser.newContext({
    viewport: page.viewportSize() ?? undefined,
  });
  const third = await thirdCtx.newPage();
  await join(page, "小鹿");
  await join(other, "小熊");
  await join(third, "小狐");
  await page.getByRole("button", { name: "开始游戏", exact: true }).click();
  for (const p of [page, other, third]) await opening(p);
  await request.post("/__test/skill?rank=12");
  await page.getByRole("button", { name: "摸一张牌", exact: true }).click();
  await page.getByRole("button", { name: "使用技能", exact: true }).click();
  await expect(
    page.getByText("选择两名玩家各一张牌", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("选择对手和双方相同的位置", { exact: true }),
  ).toHaveCount(0);
  const confirm = page.getByRole("button", { name: "确认技能", exact: true });
  await expect(confirm).toBeDisabled();
  await page
    .getByRole("button", { name: "我的牌 第 1 张", exact: true })
    .click();
  await page
    .getByRole("button", { name: "我的牌 第 4 张", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "我的牌 第 1 张", exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
  await expect(confirm).toBeDisabled();
  await page
    .getByRole("button", { name: "小熊的牌 第 2 张", exact: true })
    .click();
  await expect(confirm).toBeEnabled();
  await expect(page.getByTestId("exchange-selection")).toContainText(
    "小鹿 · 第 4 张",
  );
  await page
    .getByRole("button", { name: "我的牌 第 4 张", exact: true })
    .click();
  await expect(confirm).toBeDisabled();
  const thirdTab = page.getByRole("button", {
    name: "小狐 · 4 张",
    exact: true,
  });
  if (await thirdTab.isVisible()) await thirdTab.click();
  await page
    .getByRole("button", { name: "小狐的牌 第 4 张", exact: true })
    .click();
  await expect(page.getByTestId("exchange-selection")).toContainText(
    "小熊 · 第 2 张",
  );
  await expect(page.getByTestId("exchange-selection")).toContainText(
    "小狐 · 第 4 张",
  );
  await expect(
    page.getByRole("button", { name: "我的牌 第 1 张", exact: true }),
  ).toBeDisabled();
  const otherTab = page.getByRole("button", {
    name: "小熊 · 4 张",
    exact: true,
  });
  if (await otherTab.isVisible()) await otherTab.click();
  await expect(
    page.getByRole("button", { name: "小熊的牌 第 2 张", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(confirm).toBeEnabled();
  await page.screenshot({
    path: `artifacts/exchange-${test.info().project.name}.png`,
    fullPage: true,
  });
  await confirm.click();
  for (const p of [other, third])
    await expect(p.getByTestId("skill-notice")).toHaveText(
      "小鹿 发动了交换技能",
    );
  await expect(page.getByTestId("skill-notice")).toHaveCount(0);
  await expect(page.getByTestId("pending-card")).toHaveCount(0);
  await expect(page.getByTestId("exchange-selection")).toHaveCount(0);
  await expect(page.locator("body")).toContainText(
    "小鹿 交换了 小熊 的第 2 张牌和 小狐 的第 4 张牌",
  );
  for (const p of [page, other, third]) {
    await expect(p.getByRole("dialog", { name: "私密查看" })).toHaveCount(0);
    for (const img of await p.locator(".card-slot img").all())
      await expect(img).toHaveAttribute("alt", "暗牌");
    expect(
      await p.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
  await expect(other.getByTestId("skill-notice")).toHaveCount(0, {
    timeout: 6000,
  });
  await other.reload();
  await expect(other.locator(".connection")).toContainText("已连接");
  await expect(other.getByTestId("skill-notice")).toHaveCount(0);
  await page.getByRole("button", { name: "结束整场", exact: true }).click();
  await page
    .getByRole("button", { name: "确认结束并返回大厅", exact: true })
    .click();
  await ctx.close();
  await thirdCtx.close();
});

test("skill announcement survives immediate round settlement", async ({
  page,
  browser,
  request,
}) => {
  await request.post("/__test/reset");
  const ctx = await browser.newContext({
    viewport: page.viewportSize() ?? undefined,
  });
  const other = await ctx.newPage();
  await join(page, "小鹿");
  await join(other, "小熊");
  await page.getByRole("button", { name: "开始游戏", exact: true }).click();
  await opening(page);
  await opening(other);
  await request.post("/__test/skill?rank=11&last=true");
  await page.getByRole("button", { name: "摸一张牌", exact: true }).click();
  await page.getByRole("button", { name: "使用技能", exact: true }).click();
  await page
    .getByRole("button", { name: "我的牌 第 1 张", exact: true })
    .click();
  await page
    .getByRole("button", { name: "小熊的牌 第 3 张", exact: true })
    .click();
  await page.getByRole("button", { name: "确认技能", exact: true }).click();
  await expect(
    other.getByRole("heading", { name: "本轮结算", level: 1 }),
  ).toBeVisible();
  await expect(other.getByTestId("skill-notice")).toHaveText(
    "小鹿 发动了交换技能",
  );
  await other.screenshot({
    path: `artifacts/skill-notice-${test.info().project.name}.png`,
    fullPage: true,
  });
  await expect(page.getByTestId("skill-notice")).toHaveCount(0);
  await expect(other.getByTestId("skill-notice")).toHaveCount(0, {
    timeout: 6000,
  });
  await ctx.close();
});
