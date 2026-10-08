import { chromium } from "@playwright/test";
import { writeFileSync } from "node:fs";

const BASE = "http://127.0.0.1:5173";
const OUT = ".artifacts/qa3/QA3-18";
const browser = await chromium.launch({ channel: "chrome" });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const out = {};
page.on("response", async (r) => {
  if (r.url().includes("/members/growth")) {
    try { out.growthResponse = await r.json(); } catch {}
  }
});

await page.goto(`${BASE}/login`);
await page.getByLabel("이메일").fill("a@naver.com");
await page.getByLabel("비밀번호").fill("aaaaaaaa");
await page.getByRole("button", { name: "로그인" }).click();
await page.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 15000 });
await page.evaluate(() => localStorage.setItem("orbitflow.demoMode", "0")); // live mode -> trend modal is live

await page.goto(`${BASE}/members`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(1500);
await page.locator("h1").first().waitFor({ timeout: 8000 }).catch(() => {});
await page.waitForTimeout(300);

// open the first stat card detail (trendable = /members)
const detailButtons = page.locator(".stat-card").first().locator("button, a");
await detailButtons.first().click().catch(async () => {
  // try the "자세히" inside first stat card
  await page.locator(".stat-card").first().locator('[aria-label*="구성원 목록"], [onclick]').first().click().catch(() => {});
});
await page.waitForTimeout(2500);
out.modalOpen = await page.locator('.modal[role="dialog"]').count();
out.trend = await page.evaluate(() => {
  const modal = document.querySelector('.modal[role="dialog"]');
  if (!modal) return null;
  const chart = modal.querySelector(".bar-chart");
  const bars = [...modal.querySelectorAll(".bar-chart__col")].map((c) => ({
    label: c.querySelector(".bar-chart__label")?.textContent,
    height: c.querySelector(".bar-chart__bar")?.getAttribute("style"),
  }));
  const summary = [...modal.querySelectorAll(".modal__summary dd")].map((d) => d.textContent);
  const foot = modal.querySelector(".modal__foot")?.textContent;
  const aria = chart?.getAttribute("aria-label");
  return { bars, summary, foot, aria, chartAriaDetail: aria };
});
await page.screenshot({ path: `${OUT}/E_TREND.png` });

writeFileSync(`${OUT}/trend.json`, JSON.stringify(out, null, 2));
console.log("TREND_DONE");
await browser.close();
