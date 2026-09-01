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
  await page.evaluate(() => localStorage.setItem("orbitflow.demoMode", "0"));
  await page.goto("http://127.0.0.1:5173/");
  await page.waitForLoadState("networkidle");
  const stats = await page.locator(".stat-card").allInnerTexts();
  assert(stats.some((text) => text.includes("구성원")), "dashboard must localize members");
  assert(stats.some((text) => text.includes("프로젝트")), "dashboard must localize projects");
  assert(stats.every((text) => !/^(members|projects|tasks|documents)\b/m.test(text)), "raw English keys must not appear");
  console.log("QA_DASHBOARD_LABELS_PASS");
} finally {
  await browser.close();
}
