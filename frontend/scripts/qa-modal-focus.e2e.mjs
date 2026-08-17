import assert from "node:assert/strict";
import { chromium } from "@playwright/test";

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage();

try {
  await page.goto("http://127.0.0.1:5173/login");
  await page.getByLabel("이메일").fill("a@naver.com");
  await page.getByLabel("비밀번호").fill("aaaaaaaa");
  await page.getByRole("button", { name: "로그인" }).click();
  await page.waitForURL((url) => !url.pathname.includes("/login"));
  await page.goto("http://127.0.0.1:5173/assets");

  const trigger = page.getByRole("button", { name: "새로 만들기" });
  await trigger.focus();
  await trigger.click();
  const dialog = page.getByRole("dialog");
  assert.equal(await dialog.evaluate((node) => node.contains(document.activeElement)), true, "focus must enter dialog");

  for (let index = 0; index < 12; index += 1) await page.keyboard.press("Tab");
  assert.equal(await dialog.evaluate((node) => node.contains(document.activeElement)), true, "focus must remain trapped");

  await page.keyboard.press("Escape");
  assert.equal(await dialog.count(), 0, "Escape must close dialog");
  assert.equal(await trigger.evaluate((node) => node === document.activeElement), true, "focus must return to trigger");
  console.log("QA_MODAL_FOCUS_PASS");
} finally {
  await browser.close();
}
