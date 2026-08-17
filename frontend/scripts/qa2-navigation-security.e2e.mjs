import assert from "node:assert/strict";
import { chromium } from "@playwright/test";

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage();

try {
  await page.goto("http://127.0.0.1:5173/login?next=https://example.com");
  await page.getByLabel("이메일").fill("a@naver.com");
  await page.getByLabel("비밀번호").fill("aaaaaaaa");
  await page.getByRole("button", { name: "로그인" }).click();
  await page.waitForLoadState("domcontentloaded");
  assert.equal(new URL(page.url()).origin, "http://127.0.0.1:5173", "external next URL must be rejected");

  if (page.url().includes("/login")) {
    await page.goto("http://127.0.0.1:5173/login");
    await page.getByLabel("이메일").fill("a@naver.com");
    await page.getByLabel("비밀번호").fill("aaaaaaaa");
    await page.getByRole("button", { name: "로그인" }).click();
    await page.waitForURL((url) => !url.pathname.includes("/login"));
  }
  await page.goto("http://127.0.0.1:5173/assets");
  const demoToggle = page.locator("button", { hasText: /데모 (ON|OFF)/ });
  if ((await demoToggle.innerText()).includes("OFF")) await demoToggle.click();
  await page.reload();
  const firstRow = page.getByRole("row").nth(1);
  const rowId = (await firstRow.getByRole("cell").first().innerText()).trim();
  await firstRow.click();
  assert.equal(decodeURIComponent(new URL(page.url()).pathname), `/assets/${rowId}`, "asset row must use its real identifier");

  console.log("QA2_NAVIGATION_SECURITY_PASS");
} finally {
  await browser.close();
}
