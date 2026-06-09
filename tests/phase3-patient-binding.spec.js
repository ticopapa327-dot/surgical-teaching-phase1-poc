import { expect, test } from "@playwright/test";

test("phase 3 patient binding handles missing patient and clearing", async ({ page }) => {
  await page.goto("/");

  await page.getByLabel("HIS ID").fill("UNKNOWN");
  await page.getByRole("button", { name: "模拟 HIS 查询" }).click();
  await expect(page.getByText("未查询到患者，当前录像不会绑定患者信息。")).toBeVisible();

  await page.getByLabel("HIS ID").fill("HIS-002");
  await page.getByRole("button", { name: "模拟 HIS 查询" }).click();
  await expect(page.getByText("患者 002 / HIS-002 / 泌尿外科")).toBeVisible();
  await expect(page.getByText("腹腔镜肾囊肿去顶术")).toBeVisible();

  await page.getByRole("button", { name: "清除绑定" }).click();
  await expect(page.getByText("未绑定患者")).toBeVisible();
});
