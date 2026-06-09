import { expect, test } from "@playwright/test";

test("phase 2 call workflow renders and reaches active interaction state", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "手术示教 Phase 2 PoC" })).toBeVisible();
  await expect(page.locator(".channel-card")).toHaveCount(4);
  await expect(page.getByLabel("信令地址")).toHaveValue("ws://127.0.0.1:7077/signal");
  await expect(page.getByLabel("本端 ID")).toHaveValue("or-local");

  await page.getByRole("button", { name: "启动全部预览" }).click();
  await page.getByRole("button", { name: "开始选中通道录制" }).click();
  await page.waitForTimeout(600);
  await page.locator(".top-actions button.danger").click();
  await expect(page.locator(".recording-item")).toHaveCount(1);

  await expect(page.getByText("阶段 2 呼叫控制")).toBeVisible();

  await page.getByRole("button", { name: "示教室呼叫手术室" }).click();
  await expect(page.getByText("待确认呼叫")).toBeVisible();

  await page.getByRole("button", { name: "接受呼叫" }).click();
  await expect(page.getByText("最终模式", { exact: true })).toBeVisible();
  await expect(page.locator(".session-list dd").filter({ hasText: "交互模式" })).toBeVisible();
  await expect(page.getByText("通道 1 全景").first()).toBeVisible();

  await page.getByLabel("通道 2 术野").check();
  await page.getByRole("button", { name: "双画面" }).click();
  await expect(page.locator(".remote-video-tile")).toHaveCount(2);

  await page.getByLabel("手术室端标注远端可见").check();
  await expect(page.locator(".annotation").first()).toBeVisible();

  await page.getByRole("button", { name: "模拟新增参会者" }).click();
  await expect(page.locator(".notice").filter({ hasText: "已达到手术室端设置的" })).toBeVisible();
});
