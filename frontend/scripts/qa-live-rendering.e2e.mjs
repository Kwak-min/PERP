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

  await page.goto("http://127.0.0.1:5173/settings/integrations");
  await page.waitForLoadState("networkidle");
  const body = await page.locator("body").innerText();
  assert.doesNotMatch(body, /\b(created_at|updated_at|tenant_id|org_id|next_cursor)\b/, "raw API keys must not leak");
  assert.doesNotMatch(body, /상세\s+상세/, "nested values must not collapse into repeated detail placeholders");

  await page.goto("http://127.0.0.1:5173/assets/reservations");
  await page.waitForLoadState("networkidle");
  const leaveBody = await page.locator("body").innerText();
  assert.match(leaveBody, /아직 자산 예약 항목이 없습니다|데이터 없음/, "empty live response must render an explicit empty state");

  console.log("QA_LIVE_RENDERING_PASS");
} finally {
  await browser.close();
}
