import { expect, type Page } from "@playwright/test";
export async function enterFirstRoom(page: Page) {
  await expect(page.locator(".connection")).toContainText("已连接");
  if (await page.getByTestId("room-summary").count())
    await page
      .getByTestId("room-summary")
      .first()
      .getByRole("button", { name: "加入", exact: true })
      .click();
  else
    await page.getByRole("button", { name: "创建房间", exact: true }).click();
}
