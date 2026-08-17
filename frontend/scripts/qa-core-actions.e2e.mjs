import assert from "node:assert/strict";
import { chromium } from "@playwright/test";

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

try {
  page.setDefaultTimeout(10_000);
  await page.goto("http://127.0.0.1:5173/login");
  await page.getByLabel("이메일").fill("a@naver.com");
  await page.getByLabel("비밀번호").fill("aaaaaaaa");
  await page.getByRole("button", { name: "로그인" }).click();
  await page.waitForURL((url) => !url.pathname.includes("/login"));
  await page.evaluate(() => localStorage.setItem("orbitflow.demoMode", "0"));

  await page.goto("http://127.0.0.1:5173/assets");
  await page.getByRole("button", { name: "새로 만들기" }).click();
  assert.equal(await page.getByRole("dialog").isVisible(), true, "create must open a functional dialog");

  await page.keyboard.press("Escape");
  await page.evaluate(() => localStorage.setItem("orbitflow.demoMode", "1"));
  await page.reload();
  await page.getByRole("row").nth(1).click();
  assert.match(page.url(), /\/assets\/[^/]+$/, "asset row must open detail route");

  await page.goto("http://127.0.0.1:5173/");
  const globalSearch = page.getByRole("searchbox", { name: "전역 검색" });
  await globalSearch.fill("a@naver.com");
  await globalSearch.press("Enter");
  assert.match(page.url(), /\/members/, "email-like global search must route to members");

  console.log("QA_CORE_ACTIONS_PASS");
} finally {
  await browser.close();
}
