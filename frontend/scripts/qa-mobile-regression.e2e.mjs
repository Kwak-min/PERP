import assert from "node:assert/strict";
import { chromium } from "@playwright/test";

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 375, height: 812 } });
const errors = [];

try {
  page.on("pageerror", (error) => errors.push(`page: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  await page.goto("http://127.0.0.1:5173/login");
  await page.getByLabel("이메일").fill("a@naver.com");
  await page.getByLabel("비밀번호").fill("aaaaaaaa");
  await page.getByRole("button", { name: "로그인" }).click();
  await page.waitForURL((url) => !url.pathname.includes("/login"));
  await page.goto("http://127.0.0.1:5173/members");

  const viewportWidth = await page.evaluate(() => document.documentElement.clientWidth);
  const overflowWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  assert(overflowWidth <= viewportWidth, `page overflows horizontally: ${overflowWidth} > ${viewportWidth}`);

  await page.getByRole("button", { name: "구성원 목록 자세히 보기" }).last().click();
  const dialog = page.getByRole("dialog", { name: "구성원 목록" });
  const box = await dialog.boundingBox();
  assert(box);
  assert(box.x >= 0 && box.x + box.width <= viewportWidth, "mobile modal must fit viewport");
  await page.screenshot({ path: "qa-mobile-members.png", fullPage: false });
  assert.deepEqual(errors, [], `mobile browser errors: ${errors.join(" | ")}`);
  console.log("QA_MOBILE_REGRESSION_PASS");
} finally {
  await browser.close();
}
