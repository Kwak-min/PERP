import assert from "node:assert/strict";
import { chromium } from "@playwright/test";

const browser = await chromium.launch({ channel: "chrome" });

try {
  for (const viewport of [
    { name: "desktop", width: 1280, height: 900 },
    { name: "mobile", width: 375, height: 812 },
  ]) {
    const page = await browser.newPage({ viewport });
    page.setDefaultTimeout(10_000);
    await page.goto("http://127.0.0.1:5173/login", { waitUntil: "domcontentloaded", timeout: 15_000 });
    await page.getByLabel("이메일").fill("a@naver.com");
    await page.getByLabel("비밀번호").fill("aaaaaaaa");
    await page.getByRole("button", { name: "로그인" }).click();
    await page.waitForURL((url) => !url.pathname.includes("/login"));
    await page.goto("http://127.0.0.1:5173/members");
    await page.getByRole("button", { name: "구성원 목록 자세히 보기" }).last().click();

    const dialog = page.getByRole("dialog", { name: "구성원 목록" });
    const box = await dialog.boundingBox();
    assert(box);
    assert(box.x >= 0 && box.y >= 0);
    assert(box.x + box.width <= viewport.width);
    assert(box.y + box.height <= viewport.height);
    await page.screenshot({ path: `member-modal-${viewport.name}.png`, fullPage: false });
    await page.close();
  }
  console.log("MEMBER_MODAL_VISUAL_PASS");
} finally {
  await browser.close();
}
