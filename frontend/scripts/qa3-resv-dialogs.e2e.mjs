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

await p.goto(BASE + "/assets/reservations");
await p.waitForLoadState("domcontentloaded");
await p.waitForTimeout(500);

console.log("dialogs BEFORE click:", await p.locator("[role=dialog]").count());
for (let i = 0; i < (await p.locator("[role=dialog]").count()); i++) {
  console.log(` pre-dialog[${i}] innerText:`, JSON.stringify((await p.locator("[role=dialog]").nth(i).innerText().catch(() => "?" )).slice(0, 400)));
}

await p.getByRole("button", { name: "새로 만들기" }).first().click();
await p.waitForTimeout(300);
console.log("dialogs AFTER click:", await p.locator("[role=dialog]").count());
for (let i = 0; i < (await p.locator("[role=dialog]").count()); i++) {
  console.log(`post-dialog[${i}] innerText:`, JSON.stringify((await p.locator("[role=dialog]").nth(i).innerText().catch(() => "?" )).slice(0, 500)));
}

// screenshot showing both
await p.screenshot({ path: `${OUT}/QA3-06-reservations-two-dialogs.png`, fullPage: false });
await p.close();
await browser.close();
