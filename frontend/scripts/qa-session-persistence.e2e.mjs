import assert from "node:assert/strict";
import { chromium } from "@playwright/test";

const browser = await chromium.launch({ channel: "chrome" });

try {
  const persistent = await browser.newPage();
  await persistent.goto("http://127.0.0.1:5173/login");
  await persistent.getByLabel("이메일").fill("a@naver.com");
  await persistent.getByLabel("비밀번호").fill("aaaaaaaa");
  await persistent.getByLabel("로그인 유지").uncheck();
  await persistent.getByRole("button", { name: "로그인" }).click();
  await persistent.waitForURL((url) => !url.pathname.includes("/login"));

  const storage = await persistent.evaluate(() => ({
    local: localStorage.getItem("orbitflow.session.v1"),
    session: sessionStorage.getItem("orbitflow.session.v1"),
  }));
  assert.equal(storage.local, null, "unchecked remember-me must not persist in localStorage");
  assert.equal(typeof storage.session, "string", "unchecked remember-me must use sessionStorage");

  console.log("QA_SESSION_PERSISTENCE_PASS");
} finally {
  await browser.close();
}
