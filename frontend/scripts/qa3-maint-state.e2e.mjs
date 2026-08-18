import { chromium } from "@playwright/test";
const BASE = "http://127.0.0.1:5173";
const OUT = ".artifacts/qa3/QA3-06";
const browser = await chromium.launch({ channel: "chrome" });
const p = await browser.newPage();

await p.goto(BASE + "/login");
await p.evaluate(() => localStorage.clear());
await p.evaluate(() => localStorage.setItem("orbitflow.demoMode", "1"));
await p.goto(BASE + "/login");
await p.getByLabel("이메일").fill("a@naver.com");
await p.getByLabel("비밀번호").fill("aaaaaaaa");
await p.getByRole("button", { name: "로그인" }).click();
await p.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 15000 });

// Asset list detail capture (demo)
await p.goto(BASE + "/assets");
await p.waitForLoadState("domcontentloaded");
const astRows = [];
for (let i = 0; i < (await p.locator("tbody tr").count()); i++) astRows.push((await p.locator("tbody tr").nth(i).innerText()));
console.log("=== AST-001 rows ===");
astRows.forEach((r) => console.log(r.replace(/\t/g," | ")));

// For each asset, navigate and capture fact asset_no + first stat
// EQ-2025-014 프로젝터 (점검 필요), EQ-2025-021 XLR (재고 임계)
for (const id of ["EQ-2025-014", "EQ-2025-021", "FN-2024-003"]) {
  await p.goto(`${BASE}/assets/${id}`);
  await p.waitForLoadState("domcontentloaded");
  await p.waitForTimeout(200);
  const kv = await p.locator(".detail-layout .kv-list").first().innerText().catch(()=>"");
  const kvClean = kv.split("\n").filter((l,i,arr)=> i%2===0 ? Boolean(l.trim()) : true).join(" | ");
  const stats = [];
  for (let i = 0; i < (await p.locator(".stat-card").count()); i++) {
    stats.push((await p.locator(".stat-card").nth(i).innerText()).split("\n").slice(0,4).join(" "));
  }
  console.log(`\n=== /assets/${id} ===`);
  console.log("kv:", kv.replace(/\n/g," / "));
  console.log("stats:", JSON.stringify(stats));
}

await p.close();
await browser.close();
