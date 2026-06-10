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

  await page.locator(".recording-actions").getByRole("button", { name: "上传FTP" }).click();
  await expect(page.locator(".footer")).toContainText("FTP 上传失败：ftp_not_available_in_browser");

  await page.locator(".recording-actions").getByRole("button", { name: "删除" }).click();
  await expect(page.locator(".recording-item")).toHaveCount(0);
  await expect(page.locator(".footer")).toContainText("录像已删除");
  await expect(page.getByText("暂无录像。完成录制后会自动生成索引。")).toBeVisible();
});

test("recording stop reports close failures and clears active state", async ({ page }) => {
  await page.addInitScript(() => {
    window.surgicalApi = {
      getAppInfo: async () => ({
        appName: "browser-recording-failure-test",
        appVersion: "0.1.0",
        recordingsDir: ""
      }),
      displays: {
        list: async () => []
      },
      recordings: {
        create: async () => ({ id: "failing-recording", fileName: "failing.webm", filePath: "" }),
        writeChunk: async () => ({ ok: true, bytes: 1 }),
        close: async () => ({ ok: false, reason: "disk_full" }),
        list: async () => [],
        delete: async () => ({ ok: true }),
        reveal: async () => ({ ok: true }),
        export: async () => ({ ok: true }),
        openRoot: async () => ({ ok: true })
      }
    };
  });

  await page.goto("/");
  await page.getByRole("button", { name: "启动全部预览" }).click();
  await page.getByRole("button", { name: "录制本通道" }).first().click();
  await expect(page.locator(".footer")).toContainText("正在录制");

  await page.locator(".channel-controls button.danger").first().click();
  await expect(page.locator(".footer")).toContainText("录制停止失败：disk_full");
  await expect(page.getByRole("button", { name: "录制本通道" }).first()).toBeVisible();
});
