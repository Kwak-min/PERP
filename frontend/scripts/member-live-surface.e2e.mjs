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
  await page.evaluate(() => localStorage.setItem("orbitflow.demoMode", "0"));
  page.on("response", async (response) => {
    if (response.url().includes("/members")) {
      console.log("MEMBERS_RESPONSE", response.status(), await response.text());
    }
  });
  await page.goto("http://127.0.0.1:5173/members");

  const table = page.getByRole("table");
  await table.getByText("더미 사용자").waitFor();
  await table.getByText("a@naver.com").waitFor();
  await page.screenshot({ path: "member-live-page.png", fullPage: false });

  await page.getByRole("button", { name: "구성원 목록 자세히 보기" }).last().click();
  const dialog = page.getByRole("dialog", { name: "구성원 목록" });
  await dialog.getByRole("searchbox", { name: "구성원 검색" }).fill("a@naver.com");
  await dialog.getByText("검색 결과 1명").waitFor();
  await dialog.getByText("a@naver.com").waitFor();
  await page.screenshot({ path: "member-search-modal.png", fullPage: false });

  console.log("MEMBER_LIVE_SURFACE_PASS");
} finally {
  await browser.close();
}
