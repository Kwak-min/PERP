import { chromium } from "@playwright/test";
const BASE = "http://127.0.0.1:5173";
const OUT = ".artifacts/qa3/QA3-06";
const browser = await chromium.launch({ channel: "chrome" });
const p = await browser.newPage();

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

// SERVER mode
await login(p, false);

// assets list
await p.goto(BASE + "/assets");
await p.waitForLoadState("domcontentloaded");
console.log("SERVER assets rows:", await p.locator("tbody tr").count(), "| empty-state:", JSON.stringify((await p.locator(".empty-state, .state-boundary").first().innerText().catch(()=>"?"))));
const astBadges = await p.locator(".screen-header__meta .badge").allInnerTexts();
console.log("SERVER assets badges:", JSON.stringify(astBadges));

// reservations list
await p.goto(BASE + "/assets/reservations");
await p.waitForLoadState("domcontentloaded");
console.log("SERVER reservations rows:", await p.locator("tbody tr").count());
const resvBadges = await p.locator(".screen-header__meta .badge").allInnerTexts();
console.log("SERVER reservations badges:", JSON.stringify(resvBadges));
console.log("SERVER reservations stats:", JSON.stringify(await p.locator(".stat-card").allInnerTexts().catch(()=>[])));
const resvEmpty = await p.locator(".state-boundary, .empty-state").first().innerText().catch(()=>"?");
console.log("SERVER reservations empty-state:", JSON.stringify(resvEmpty));
await p.screenshot({ path: `${OUT}/QA3-06-reservations-server.png`, fullPage: false });

// Now in the SAME server-mode session, hit the detail route directly
await p.goto(BASE + "/assets/FN-2024-003");
await p.waitForLoadState("domcontentloaded");
await p.waitForTimeout(200);
const resvDetailBadges = await p.locator(".screen-header__meta .badge").allInnerTexts();
console.log("SERVER-mode direct detail /assets/FN-2024-003 badges:", JSON.stringify(resvDetailBadges));
const kv = await p.locator(".detail-layout .kv-list").first().innerText().catch(()=>"");
console.log("SERVER-mode direct detail kv:", JSON.stringify(kv));
await p.screenshot({ path: `${OUT}/QA3-06-servermode-detail.png`, fullPage: false });

await p.close();
await browser.close();
