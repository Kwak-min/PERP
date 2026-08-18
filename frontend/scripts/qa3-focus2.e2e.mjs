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

// >>>> RESERVATION create flow with accurate dialog targeting
await p.goto(BASE + "/assets/reservations");
await p.waitForLoadState("domcontentloaded");
const qc = p.locator("form.quick-create-modal");
console.log("create modal present before click:", await qc.count());
await p.getByRole("button", { name: "새로 만들기" }).first().click();
await p.waitForTimeout(250);
console.log("create modal present after click:", await qc.count());
console.log("create modal text:", JSON.stringify((await qc.innerText().catch(()=>"?"))));
// fill name and submit
await qc.locator("input").first().fill("중복 테스트 예약");
await p.screenshot({ path: `${OUT}/QA3-06-resv-modal-filled.png` });
await qc.getByRole("button", { name: "만들기" }).click();
await p.waitForTimeout(300);
// notice?
const notices = [];
const sr = p.locator("[role=status]");
for (let i = 0; i < (await sr.count()); i++) notices.push((await sr.nth(i).innerText().catch(()=>"")));
console.log("notices after submit:", JSON.stringify(notices));
console.log("URL after submit:", p.url());
console.log("create modal still present after submit:", await qc.count());
const rowsN1 = [];
for (let i = 0; i < (await p.locator("tbody tr").count()); i++) rowsN1.push((await p.locator("tbody tr").nth(i).innerText()));
console.log("reservation rows after submit:", JSON.stringify(rowsN1));

// Does the supposedly-created reservation appear? (truthfulness)
await p.reload();
await p.waitForLoadState("domcontentloaded");
const rowsN2 = [];
for (let i = 0; i < (await p.locator("tbody tr").count()); i++) rowsN2.push((await p.locator("tbody tr").nth(i).innerText()));
console.log("reservation rows after reload:", JSON.stringify(rowsN2));

// >>>> RESERVATION row click: does the reservations row navigate anywhere / is the 자원 column an id?
// capture whether tbody rows have interactive class
const interactiveCount = await p.locator("tbody tr.table-row--interactive").count();
console.log("reservation rows interactive:", interactiveCount);
await p.screenshot({ path: `${OUT}/QA3-06-resv-list-final.png` });

// >>>> ASSET list filter '점검' (maintenance) — verify filter narrows correctly
await p.goto(BASE + "/assets");
await p.waitForLoadState("domcontentloaded");
const chips = await p.locator(".chip").allInnerTexts();
console.log("asset filter chips:", JSON.stringify(chips));
// click '점검'
await p.locator(".chip", { hasText: "점검" }).click();
await p.waitForTimeout(250);
const filterRows = [];
for (let i = 0; i < (await p.locator("tbody tr").count()); i++) filterRows.push((await p.locator("tbody tr").nth(i).innerText()));
console.log("asset rows after '점검' filter:", JSON.stringify(filterRows));
const resultTxt = await p.locator(".filter-bar__result").innerText().catch(()=>"");
console.log("asset filter result text:", JSON.stringify(resultTxt));
await p.screenshot({ path: `${OUT}/QA3-06-assets-filter-check.png` });

// clear filter by clicking 전체
await p.locator(".chip", { hasText: "전체" }).click();
await p.waitForTimeout(200);

// >>>> click third row (프로젝터, '점검 필요') and capture detail
await p.locator("tbody tr").nth(2).click();
await p.waitForURL((u)=>u.pathname.startsWith("/assets/"), { timeout: 8000 });
console.log("URL for 프로젝터 click:", p.url());
const facts3 = await p.locator(".kv-list dd").allInnerTexts();
console.log("detail facts for 프로젝터 click:", JSON.stringify(facts3));
const statTxt = await p.locator(".stat-card").first().innerText().catch(()=>"");
console.log("detail first stat:", JSON.stringify(statTxt));
await p.screenshot({ path: `${OUT}/QA3-06-assets-proj-detail.png` });

await p.close();
await browser.close();
