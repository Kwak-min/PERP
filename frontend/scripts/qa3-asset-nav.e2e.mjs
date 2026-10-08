import { chromium } from "@playwright/test";

const BASE = "http://127.0.0.1:5173";
const OUT = ".artifacts/qa3/QA3-06";

const browser = await chromium.launch({ channel: "chrome" });

async function login(page, demo) {
  await page.goto(BASE + "/login");
  await page.evaluate(() => localStorage.clear());
  await page.evaluate((v) => localStorage.setItem("orbitflow.demoMode", v ? "1" : "0"), demo);
  await page.goto(BASE + "/login");
  await page.getByLabel("이메일").fill("a@naver.com");
  await page.getByLabel("비밀번호").fill("aaaaaaaa");
  await page.getByRole("button", { name: "로그인" }).click();
  await page.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 15000 });
}

// ===== DEMO MODE ON =====
const dpage = await browser.newPage();
await login(dpage, true);
await dpage.goto(BASE + "/assets");
console.log("DEMO /assets table headers:", await dpage.locator("th").allInnerTexts().catch(() => []));
// capture rows
const demoRows = [];
for (let i = 0; i < (await dpage.locator("tbody tr").count()); i++) {
  demoRows.push(await dpage.locator("tbody tr").nth(i).innerText());
}
console.log("DEMO /assets rows:\n" + demoRows.join("\n"));
await dpage.screenshot({ path: `${OUT}/QA3-06-assets-demo-list.png`, fullPage: false });

// click the FIRST asset row
await dpage.locator("tbody tr").first().click();
await dpage.waitForURL((u) => u.pathname.startsWith("/assets/"), { timeout: 10000 });
console.log("DEMO after first row click URL:", dpage.url());
const url1 = dpage.url();
const detail1Facts = await dpage.locator(".kv-list dd").allInnerTexts().catch(() => []);
console.log("DEMO detail1 (url=" + url1 + ") facts:", JSON.stringify(detail1Facts));
await dpage.screenshot({ path: `${OUT}/QA3-06-assets-demo-detail1.png`, fullPage: false });

// go back, click the SECOND asset row (EQ-2026-002 = 마이크 스탠드)
await dpage.goto(BASE + "/assets");
const secondUrl = await dpage.evaluate(() => {
  const rows = document.querySelectorAll("tbody tr");
  rows[1].click();
  return location.href;
});
await dpage.waitForURL((u) => u.pathname !== "/assets", { timeout: 10000 });
console.log("DEMO after second row click URL:", dpage.url());
const detail2Facts = await dpage.locator(".kv-list dd").allInnerTexts().catch(() => []);
console.log("DEMO detail2 facts:", JSON.stringify(detail2Facts));
await dpage.screenshot({ path: `${OUT}/QA3-06-assets-demo-detail2.png`, fullPage: false });

// Now test direct navigation with a NON-EXISTENT id
await dpage.goto(BASE + "/assets/NOPE-999");
await dpage.waitForLoadState("domcontentloaded");
const nopeH1 = await dpage.locator(".screen-header h1").innerText().catch(() => "?");
const nopeFacts = await dpage.locator(".kv-list dd").allInnerTexts().catch(() => []);
console.log("DIRECT /assets/NOPE-999 -> h1=" + nopeH1 + " facts=" + JSON.stringify(nopeFacts));
await dpage.screenshot({ path: `${OUT}/QA3-06-assets-demo-nope.png`, fullPage: false });

await dpage.close();

// ===== SERVER MODE (demo OFF) =====
const spage = await browser.newPage();
await login(spage, false);
await spage.goto(BASE + "/assets");
console.log("SERVER /assets headers:", await spage.locator("th").allInnerTexts().catch(() => []));
console.log("SERVER /assets rows count:", await spage.locator("tbody tr").count());
const badge = await spage.locator(".screen-header__meta .badge").allInnerTexts().catch(() => []);
console.log("SERVER /assets badges:", JSON.stringify(badge));
await spage.screenshot({ path: `${OUT}/QA3-06-assets-server-list.png`, fullPage: false });

// direct navigation in server mode to an asset id
await spage.goto(BASE + "/assets/EQ-2026-001");
await spage.waitForLoadState("domcontentloaded");
const sFacts = await spage.locator(".kv-list dd").allInnerTexts().catch(() => []);
console.log("SERVER /assets/EQ-2026-001 facts:", JSON.stringify(sFacts));
const sBadges = await spage.locator(".screen-header__meta .badge").allInnerTexts().catch(() => []);
console.log("SERVER /assets/EQ-2026-001 badges:", JSON.stringify(sBadges));
await spage.screenshot({ path: `${OUT}/QA3-06-assets-server-detail.png`, fullPage: false });

await spage.close();
await browser.close();
