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

// DEMO reservations + asset detail maintenance
const p = await browser.newPage();
await login(p, true);

// >>> RESERVATIONS (AST-003) demo
await p.goto(BASE + "/assets/reservations");
await p.waitForLoadState("domcontentloaded");
console.log("=== RESERVATIONS DEMO headers:", JSON.stringify(await p.locator("th").allInnerTexts().catch(() => [])));
const resvRows = [];
for (let i = 0; i < (await p.locator("tbody tr").count()); i++) resvRows.push((await p.locator("tbody tr").nth(i).innerText()));
console.log("RESERVATIONS DEMO rows:\n" + resvRows.join("\n"));
const resvBadges = await p.locator(".screen-header__meta .badge").allInnerTexts().catch(() => []);
console.log("RESERVATIONS badges:", JSON.stringify(resvBadges));
await p.screenshot({ path: `${OUT}/QA3-06-reservations-demo.png`, fullPage: false });
// click the '새로 만들기' button on reservations list
await p.getByRole("button", { name: "새로 만들기" }).click().catch(() => {});
const dialogTxt = await p.locator("[role=dialog]").innerText().catch(() => "no-dialog");
console.log("RESV create dialog text:", JSON.stringify(dialogTxt));
await p.screenshot({ path: `${OUT}/QA3-06-reservations-create-modal.png`, fullPage: false });
await p.keyboard.press("Escape").catch(() => {});

// filter click '충돌' — check conflict filtering
await p.goto(BASE + "/assets/reservations");
const filters = await p.locator(".chip").allInnerTexts().catch(() => []);
console.log("RESV filter chips:", JSON.stringify(filters));

// >>> ASSET DETAIL maintenance (AST-002) — inspect stats + timeline
await p.goto(BASE + "/assets/EQ-2026-001");
await p.waitForLoadState("domcontentloaded");
console.log("=== ASSET DETAIL — stat labels:", JSON.stringify(await p.locator(".stat-card").allInnerTexts().catch(() => [])));
console.log("ASSET DETAIL — kv facts:", JSON.stringify(await p.locator(".kv-list dd").allInnerTexts().catch(() => [])));
console.log("ASSET DETAIL — timeline:", JSON.stringify(await p.locator(".timeline, [class*=timeline]").allInnerTexts().catch(() => [])));
await p.screenshot({ path: `${OUT}/QA3-06-asset-detail-maintenance.png`, fullPage: false });

await p.close();
await browser.close();
