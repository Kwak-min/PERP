import { chromium } from "@playwright/test";
const BASE = "http://127.0.0.1:5173";
const browser = await chromium.launch({ channel: "chrome" });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
await page.goto(`${BASE}/login`);
console.log("login title:", await page.title());
await page.getByLabel("이메일").fill("a@naver.com");
await page.getByLabel("비밀번호").fill("aaaaaaaa");
await page.getByRole("button", { name: "로그인" }).click();
await page.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 15000 });
await page.evaluate(() => localStorage.setItem("orbitflow.demoMode", "1"));
for (const path of ["/", "/workload", "/finance", "/calendar", "/projects/proj-1/timeline"]) {
  const before = Date.now();
  await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1600);
  await page.locator("h1").first().waitFor({ timeout: 8000 }).catch(() => { console.log("NO H1 on", path); });
  await page.waitForTimeout(400);
  const r = await page.evaluate(() => ({
    url: location.pathname,
    h1: document.querySelector("h1")?.textContent,
    statCards: document.querySelectorAll(".stat-card").length,
    barChart: !!document.querySelector(".bar-chart"),
    donut: !!document.querySelector(".donut"),
    gantt: !!document.querySelector(".gantt"),
    heatmap: !!document.querySelector(".heatmap"),
    url2: location.href,
  }));
  console.log(path, (Date.now()-before)+"ms", JSON.stringify(r));
}
await browser.close();
