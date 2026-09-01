import assert from "node:assert/strict";
import { chromium } from "@playwright/test";

const routes = [
  "/", "/tasks", "/projects", "/calendar", "/members", "/org-chart",
  "/finance", "/assets", "/hr/leave", "/documents", "/agent", "/admin",
];
const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];

try {
  page.on("pageerror", (error) => errors.push(`page: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  await page.goto("http://127.0.0.1:5173/login");
  await page.getByLabel("이메일").fill("a@naver.com");
  await page.getByLabel("비밀번호").fill("aaaaaaaa");
  await page.getByRole("button", { name: "로그인" }).click();
  await page.waitForURL((url) => !url.pathname.includes("/login"));
  await page.evaluate(() => localStorage.setItem("orbitflow.demoMode", "0"));

  for (const route of routes) {
    await page.goto(`http://127.0.0.1:5173${route}`, { waitUntil: "networkidle" });
    assert.equal(await page.locator("main").isVisible(), true, `${route} main must render`);
    assert.equal(await page.locator("body").getByText("페이지를 찾을 수 없습니다").count(), 0, `${route} must exist`);
  }
  await page.screenshot({ path: "qa-final-desktop.png", fullPage: false });
  assert.deepEqual(errors, [], `browser errors: ${errors.join(" | ")}`);
  console.log(`QA_FINAL_SMOKE_PASS routes=${routes.length}`);
} finally {
  await browser.close();
}
