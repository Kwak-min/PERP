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
  await page.goto("http://127.0.0.1:5173/");

  const track = page.locator(".progress-track").first();
  const fill = track.locator(".progress-fill");
  const [trackBox, fillBox] = await Promise.all([track.boundingBox(), fill.boundingBox()]);
  assert(trackBox && fillBox);
  assert(fillBox.width > 0, "progress fill must be visible");
  assert(fillBox.width < trackBox.width, "partial progress must not fill the whole track");
  assert(Math.abs(fillBox.width / trackBox.width - 0.62) < 0.03, "fill width must match 62%");
  console.log("PROGRESS_FILL_PASS");
} finally {
  await browser.close();
}
