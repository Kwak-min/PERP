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

  await page.goto("http://127.0.0.1:5173/calendar");
  const initialEvents = await page.locator(".calendar-event").count();
  await page.getByRole("button", { name: "다음 달" }).click();
  const nextEvents = await page.locator(".calendar-event").count();
  assert.equal(nextEvents, 0, "fixture events from the current month must not repeat in another month");
  await page.getByRole("button", { name: "이전 달" }).click();
  assert.equal(await page.locator(".calendar-event").count(), initialEvents, "returning to the source month must restore its events");

  await page.route("**/api/v1/tasks**", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    await route.continue();
  });
  await page.evaluate(() => localStorage.setItem("orbitflow.demoMode", "0"));
  await page.goto("http://127.0.0.1:5173/tasks");
  assert.equal(await page.getByText("조직 데이터를 불러오는 중").isVisible(), true, "live loading must render an explicit loading boundary");
  console.log("QA2_CALENDAR_LOADING_PASS");
} finally {
  await browser.close();
}
