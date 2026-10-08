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

// reservations create flow
await p.goto(BASE + "/assets/reservations");
await p.waitForLoadState("domcontentloaded");
// count buttons named 새로 만들기
const btns = await p.locator("button:has-text('새로 만들기')").count();
console.log("총 '새로 만들기' 버튼 수:", btns);
await p.getByRole("button", { name: "새로 만들기" }).first().click();
await p.waitForTimeout(300);
console.log("dialog count after click:", await p.locator("[role=dialog]").count());
console.log("modal text:", JSON.stringify((await p.locator("[role=dialog]").innerText().catch(() => "NONE_TOO"))));
await p.screenshot({ path: `${OUT}/QA3-06-reservations-modal-open.png` });

// type a name and submit
await p.locator("[role=dialog] input").fill("충돌 테스트 예약").catch(() => {});
await p.locator("[role=dialog] button:has-text('만들기')").click().catch(() => {});
await p.waitForTimeout(300);
const notice = await p.locator("[role=status]").innerText().catch(() => "no-status");
console.log("submit notice:", JSON.stringify(notice));
console.log("URL after submit:", p.url());
await p.screenshot({ path: `${OUT}/QA3-06-reservations-after-submit.png` });

// Check if a network request to POST /reservations was made
const reqs = [];
p.on("request", (r) => { if (/reservations|assets/.test(r.url()) && r.method() === "POST") reqs.push(r.url() + " " + r.method()); });
await p.goto(BASE + "/assets/reservations");
await p.getByRole("button", { name: "새로 만들기" }).first().click();
await p.waitForTimeout(200);
await p.locator("[role=dialog] input").fill("테스트");
await p.getByRole("button", { name: "만들기" }).click();
await p.waitForTimeout(400);
console.log("POST requests captured:", JSON.stringify(reqs));

// reload to see if a new reservation row appeared
await p.reload();
await p.waitForLoadState("domcontentloaded");
const rowsAfter = [];
for (let i = 0; i < (await p.locator("tbody tr").count()); i++) rowsAfter.push((await p.locator("tbody tr").nth(i).innerText()));
console.log("rows after creating:", JSON.stringify(rowsAfter));

await p.close();
await browser.close();
