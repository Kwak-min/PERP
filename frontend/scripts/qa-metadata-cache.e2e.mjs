import assert from "node:assert/strict";
import { chromium } from "@playwright/test";

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage();

try {
  const counts = { departments: 0, roles: 0 };
  page.on("request", (request) => {
    if (request.url().includes("/members/departments")) counts.departments += 1;
    if (request.url().includes("/members/roles")) counts.roles += 1;
  });
  await page.goto("http://127.0.0.1:5173/login");
  await page.getByLabel("이메일").fill("a@naver.com");
  await page.getByLabel("비밀번호").fill("aaaaaaaa");
  await page.getByRole("button", { name: "로그인" }).click();
  await page.waitForURL((url) => !url.pathname.includes("/login"));
  await page.waitForLoadState("networkidle");
  counts.departments = 0;
  counts.roles = 0;
  for (const route of ["/members", "/assets", "/tasks", "/finance"]) {
    await page.evaluate((path) => {
      history.pushState({}, "", path);
      dispatchEvent(new PopStateEvent("popstate"));
    }, route);
    await page.waitForLoadState("networkidle");
  }
  assert.equal(counts.departments, 0, `departments repeated ${counts.departments} times after initial load`);
  assert.equal(counts.roles, 0, `roles repeated ${counts.roles} times after initial load`);
  console.log("QA_METADATA_CACHE_PASS");
} finally {
  await browser.close();
}
