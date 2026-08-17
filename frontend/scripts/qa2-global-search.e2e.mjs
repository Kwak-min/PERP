import assert from "node:assert/strict";
import { chromium } from "@playwright/test";

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage();

try {
  await page.goto("http://127.0.0.1:5173/login");
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem("orbitflow.demoMode", "0");
    sessionStorage.clear();
  });
  await page.reload();
  await page.getByLabel("이메일").fill("a@naver.com");
  await page.getByLabel("비밀번호").fill("aaaaaaaa");
  await page.getByRole("button", { name: "로그인" }).click();
  await page.waitForURL((url) => !url.pathname.includes("/login"));
  await page.goto("http://127.0.0.1:5173/members");
  const session = await page.evaluate(() => localStorage.getItem("orbitflow.session.v1"));
  assert(session, "login must persist the session before global search");
  await page.goto("http://127.0.0.1:5173/");
  await page.waitForSelector('input[placeholder="업무, 문서, 구성원 검색 후 Enter"]');

  const search = page.getByPlaceholder("업무, 문서, 구성원 검색 후 Enter");
  await search.fill("a@naver.com");
  await search.press("Enter");
  await page.waitForURL(/\/members\?q=/);
  assert.equal(await page.getByPlaceholder("이 화면에서 검색").inputValue(), "a@naver.com");
  const table = page.getByRole("region", { name: "데이터 표" });
  await table.getByText("a@naver.com").waitFor();
  assert.match(await page.locator(".filter-bar__result").innerText(), /1건/);

  console.log("QA2_GLOBAL_SEARCH_PASS");
} finally {
  await browser.close();
}
