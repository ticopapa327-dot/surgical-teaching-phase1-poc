import { expect, test } from "@playwright/test";

test("recording list supports deleting a completed recording", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: "启动全部预览" }).click();
  await page.getByRole("button", { name: "开始选中通道录制" }).click();
  await page.waitForTimeout(500);
  await page.locator(".top-actions button.danger").click();

  await expect(page.locator(".recording-item")).toHaveCount(1);
  await page.locator(".recording-actions").getByRole("button", { name: "定位" }).click();
  await expect(page.locator(".footer")).toContainText("已定位录像");

  const downloadPromise = page.waitForEvent("download");
  await page.locator(".recording-actions").getByRole("button", { name: "导出" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toContain(".webm");
  await expect(page.locator(".footer")).toContainText("录像已导出");

  await page.locator(".recording-actions").getByRole("button", { name: "删除" }).click();
  await expect(page.locator(".recording-item")).toHaveCount(0);
  await expect(page.locator(".footer")).toContainText("录像已删除");
  await expect(page.getByText("暂无录像。完成录制后会自动生成索引。")).toBeVisible();
});
