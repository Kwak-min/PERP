import { chromium } from "@playwright/test";
const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage();
try {
  await page.goto("http://127.0.0.1:5173/login");
  await page.getByLabel("이메일").fill("a@naver.com");
  await page.getByLabel("비밀번호").fill("aaaaaaaa");
  await page.getByRole("button", { name: "로그인" }).click();
  await page.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 15000 });
  console.log("LOGGED_IN_URL=" + page.url());
  console.log("TITLE=" + await page.title());
} finally {
  await browser.close();
}
