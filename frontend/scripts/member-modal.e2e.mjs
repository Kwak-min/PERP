import assert from "node:assert/strict";
import { chromium } from "@playwright/test";

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

try {
  page.setDefaultTimeout(10_000);
  await page.goto("http://127.0.0.1:5173/login", { waitUntil: "domcontentloaded", timeout: 15_000 });
  await page.getByLabel("이메일").fill("a@naver.com");
  await page.getByLabel("비밀번호").fill("aaaaaaaa");
  await page.getByRole("button", { name: "로그인" }).click();
  await page.waitForURL((url) => !url.pathname.includes("/login"));
  await page.goto("http://127.0.0.1:5173/members");

  await page.getByRole("button", { name: "구성원 목록 자세히 보기" }).last().click();
  const dialog = page.getByRole("dialog", { name: "구성원 목록" });
  await assert.doesNotReject(() => dialog.waitFor());

  await dialog.getByRole("searchbox", { name: "구성원 검색" }).fill("a@naver.com");
  await assert.doesNotReject(() => dialog.getByText("a@naver.com").waitFor());
  assert.equal(await dialog.getByText("검색 결과 1명").isVisible(), true);
  console.log("MEMBER_MODAL_PASS");
} finally {
  await browser.close();
}
