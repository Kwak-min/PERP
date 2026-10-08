import { chromium } from "@playwright/test";
import { writeFileSync } from "node:fs";

const BASE = "http://127.0.0.1:5173";
const browser = await chromium.launch({ channel: "chrome" });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
page.on("console", (m) => { if (m.type() === "error") console.log("CONSOLE_ERR:", m.text()); });

await page.goto(`${BASE}/login`);
console.log("login title:", await page.title());
await page.getByLabel("이메일").fill("a@naver.com");
await page.getByLabel("비밀번호").fill("aaaaaaaa");
await page.getByRole("button", { name: "로그인" }).click();
await page.waitForURL((url) => !url.pathname.includes("/login"), { timeout: 15000 });
console.log("after login url:", page.url());

for (const path of ["/", "/dashboard/org", "/workload"]) {
  await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1200);
  const info = await page.evaluate(() => {
    return {
      url: location.pathname,
      title: document.title,
      statCards: document.querySelectorAll(".stat-card").length,
      barCharts: document.querySelectorAll(".bar-chart").length,
      demoBadge: [...document.querySelectorAll(".badge, [class*=Badge]")].map((b) => b.textContent).slice(0, 8),
      badges: [...document.querySelectorAll(".badge")].map((b) => b.textContent),
      h1: document.querySelector("h1")?.textContent,
      bodySnippet: (document.body.innerText || "").slice(0, 200),
      nav: !!document.querySelector("nav"),
    };
  });
  console.log("ROUTE", path, JSON.stringify(info));
}

writeFileSync(".artifacts/qa3/QA3-18/debug.txt", "done");
await browser.close();
