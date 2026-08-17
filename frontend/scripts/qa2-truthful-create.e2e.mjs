import assert from "node:assert/strict";
import { chromium } from "@playwright/test";

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage();

try {
  await page.goto("http://127.0.0.1:5173/login");
  await page.getByLabel("이메일").fill("a@naver.com");
  await page.getByLabel("비밀번호").fill("aaaaaaaa");
  await page.getByRole("button", { name: "로그인" }).click();
  await page.waitForURL((url) => !url.pathname.includes("/login"));

  await page.goto("http://127.0.0.1:5173/tasks");
  await page.getByRole("button", { name: "새로 만들기" }).click();
  await page.getByPlaceholder("업무 이름").fill("QA2 저장 검증");
  await page.getByRole("dialog").getByRole("button", { name: "만들기" }).click();
  const status = page.getByRole("status");
  assert.doesNotMatch(await status.innerText(), /저장했습니다/, "generic modal must not claim an unperformed save");
  assert.match(await status.innerText(), /상세 입력|업무 화면/, "unsupported quick-create must guide to a truthful next step");

  await page.goto("http://127.0.0.1:5173/login");
  await page.getByLabel("이메일").fill("wrong@example.com");
  await page.getByLabel("비밀번호").fill("wrongpass");
  await page.getByRole("button", { name: "로그인" }).click();
  const alert = page.getByRole("alert");
  await alert.waitFor();
  await page.getByLabel("이메일").fill("a@naver.com");
  assert.equal(await alert.count(), 0, "editing a failed field must clear stale server error");

  console.log("QA2_TRUTHFUL_CREATE_PASS");
} finally {
  await browser.close();
}
