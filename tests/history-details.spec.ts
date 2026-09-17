import { test, expect } from "@playwright/test";

test("details keep focus inside and restore it on every dismissal path", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/history-details.html");
  const trigger = page.getByRole("button", { name: "Open details" });
  const dialog = page.getByRole("dialog");
  const close = dialog.getByRole("button", { name: "Close", exact: true });
  await trigger.click();
  await expect(close).toBeFocused();
  for (const key of ["Tab", "Shift+Tab"]) {
    await page.keyboard.press(key);
    await expect
      .poll(() =>
        dialog.evaluate(
          (element) =>
            document.activeElement === document.body ||
            element.contains(document.activeElement),
        ),
      )
      .toBe(true);
  }
  await page
    .getByRole("button", {
      name: "Delete background entry",
      includeHidden: true,
    })
    .evaluate((element: HTMLButtonElement) => element.focus());
  await expect(close).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await trigger.click();
  await close.click();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await page.mouse.click(2, 2);
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(page.locator("output")).toHaveText("Preserved");
});

for (const language of ["en", "zh"]) {
  for (const failure of ["asr", "translation"]) {
    test(`${language} ${failure} failure does not claim text was inserted`, async ({
      page,
    }) => {
      await page.goto(
        `/tests/fixtures/history-details.html?language=${language}&failure=${failure}`,
      );
      await page.getByRole("button", { name: "Open details" }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toContainText(
        language === "zh"
          ? "没有可用的文本模型结果。"
          : "No text model result is available.",
      );
      await expect(dialog).not.toContainText(
        language === "zh" ? "直接插入" : "inserted as is",
      );
    });
  }
}
