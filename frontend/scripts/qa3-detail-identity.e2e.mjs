import assert from "node:assert/strict";
import { chromium } from "@playwright/test";

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage();

try {
  // Live mode: asset list returns a real record; clicking it must show that
  // record's values on the detail screen, not demo fixture facts.
  await page.goto("http://127.0.0.1:5173/login");
  await page.getByLabel("이메일").fill("a@naver.com");
  await page.getByLabel("비밀번호").fill("aaaaaaaa");
  await page.getByRole("button", { name: "로그인" }).click();
  await page.waitForURL((url) => !url.pathname.includes("/login"));
  await page.evaluate(() => localStorage.setItem("orbitflow.demoMode", "0"));

  await page.route("**/api/v1/assets**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        items: [
          {
            id: "AST-REAL-001",
            name: "라이브 노트북",
            status: "active",
            assignee: "실사용자",
          },
        ],
      }),
    }),
  );
  await page.goto("http://127.0.0.1:5173/assets");
  await page.getByText("라이브 노트북").waitFor();
  await page.getByText("라이브 노트북").click();
  await page.waitForURL((url) => url.pathname.includes("/assets/"));
  await page.getByText("AST-REAL-001").first().waitFor();
  assert.equal(
    await page.getByText("데모 데이터").count(),
    0,
    "live detail must not show demo badge",
  );
  const detailText = await page.locator(".detail-layout").innerText();
  assert.match(detailText, /라이브 노트북/, "detail shows live name");
  assert.match(detailText, /실사용자/, "detail shows live assignee");
  assert.doesNotMatch(detailText, /본공연|기획/, "no demo fixture facts mixed in");
  assert.doesNotMatch(detailText, /활동 기록/, "no demo timeline on live detail");
  // Stat cards must derive from the live record, never demo fixture values.
  const statText = await page.locator(".stat-grid").innerText();
  assert.doesNotMatch(statText, /대여 중|임계 1점|점검 예정/, "no demo fixture stats on live detail");
  assert.match(statText, /실사용자/, "live detail stats derive from the record");

  // Demo mode gantt: milestone at the very end must stay inside the track.
  await page.evaluate(() => localStorage.setItem("orbitflow.demoMode", "1"));
  await page.goto("http://127.0.0.1:5173/projects/demo-1/timeline");
  await page.locator(".gantt").waitFor();
  const milestoneLefts = await page.locator(".gantt__milestone").evaluateAll((nodes) =>
    nodes.map((node) => parseFloat(node.style.left)),
  );
  assert.ok(milestoneLefts.length > 0, "gantt has milestones");
  for (const left of milestoneLefts) {
    assert.ok(left <= 97, `milestone left ${left}% overflows track`);
  }

  console.log("QA3_DETAIL_IDENTITY_PASS");
} finally {
  await browser.close();
}
