import assert from "node:assert/strict";
import { chromium } from "@playwright/test";

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage();

try {
  await page.goto("http://127.0.0.1:5173/signup");
  await page.getByLabel("이름").fill(" \u200f ");
  await page.getByLabel("이메일").fill(`qa3-${Date.now()}@example.com`);
  await page.getByLabel("비밀번호", { exact: true }).fill("abcdefgh");
  await page.getByLabel("비밀번호 확인").fill("abcdefgh");
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "계정 만들기" }).click();
  const alert = page.getByRole("alert");
  await alert.waitFor();
  assert.match(await alert.innerText(), /이름/, "Unicode whitespace-only name must receive a specific validation error");

  await page.goto("http://127.0.0.1:5173/login");
  await page.getByLabel("이메일").fill("a@naver.com");
  await page.getByLabel("비밀번호").fill("aaaaaaaa");
  await page.getByRole("button", { name: "로그인" }).click();
  await page.waitForURL((url) => !url.pathname.includes("/login"));
  await page.evaluate(() => localStorage.setItem("orbitflow.demoMode", "0"));
  await page.route("**/api/v1/tasks**", () => {});
  await page.goto("http://127.0.0.1:5173/tasks");
  await page.getByText("조직 데이터를 불러오는 중").waitFor();
  await page.getByText("데이터를 불러오지 못했습니다").waitFor({ timeout: 12_000 });

  console.log("QA3_BOUNDARIES_PASS");
} finally {
  await browser.close();
}
