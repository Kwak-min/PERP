import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

const appBase = process.env.APP_BASE ?? "http://127.0.0.1:5174";
const artifacts = new URL("../.artifacts/org-chart/", import.meta.url);
fs.mkdirSync(artifacts, { recursive: true });
const browser = await chromium.launch({ channel: "chrome" });
const context = await browser.newContext({
  colorScheme: "light",
  locale: "ko-KR",
  viewport: { width: 1280, height: 900 },
});
const page = await context.newPage();
const browserErrors = [];
page.on("console", (message) => {
  if (message.type() === "error") browserErrors.push(message.text());
});
page.on("pageerror", (error) => browserErrors.push(error.message));

try {
  await page.route("**/api/v1/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: "{}",
    });
  });
  await page.addInitScript(() => {
    localStorage.setItem(
      "orbitflow.session.v1",
      JSON.stringify({
        token: "org-chart-e2e-token",
        orgId: "org-chart-e2e-org",
        name: "조직도 관리자",
        email: "orgchart@example.com",
        mustChangePassword: false,
        organizations: [
          {
            org_id: "org-chart-e2e-org",
            org_name: "조직도 테스트",
            org_type: "club",
            roles: ["owner"],
          },
        ],
      }),
    );
    localStorage.setItem("orbitflow.demoMode", "1");
  });

  await page.goto(`${appBase}/org-chart`, { waitUntil: "domcontentloaded" });

  const addButton = page.getByRole("button", { name: "김회장 아래 하위 직급 추가" });
  await addButton.click();
  await page.getByLabel("담당자 이름").fill("장하늘");
  await page.getByLabel("직급 또는 역할").fill("운영팀장");
  await page.getByLabel("소속 부서").fill("운영팀");
  await page.getByRole("checkbox", { name: "승인 가능" }).check();
  await page.getByRole("button", { name: "조직도에 추가" }).click();

  const createdNode = page.getByRole("treeitem", { name: /장하늘 운영팀장 운영팀/ });
  await createdNode.waitFor();
  assert.match(await createdNode.innerText(), /승인 가능/);
  assert.equal(await page.locator(".orgtree__node").count(), 10);
  assert.equal(await page.locator(".orgtree__connector").count() > 0, true);
  await page.screenshot({
    path: fileURLToPath(new URL("desktop-created.png", artifacts)),
    fullPage: true,
  });

  await createdNode
    .getByRole("button", { name: "장하늘 아래 하위 직급 추가" })
    .click();
  await page.getByLabel("담당자 이름").waitFor();
  await page.screenshot({
    path: fileURLToPath(new URL("desktop-editor.png", artifacts)),
    fullPage: true,
  });
  await page.locator(".orgtree-editor").screenshot({
    path: fileURLToPath(new URL("desktop-editor-card.png", artifacts)),
  });
  await page.getByRole("button", { name: "취소" }).click();

  // 직급 단계(급) 표시
  assert.equal((await page.locator(".orgtree__level").count()) > 0, true);
  assert.match(await page.locator(".orgtree__node--root").innerText(), /1급/);

  // 승진 버튼: 루트를 제외한 모든 노드에 존재
  const nodeCount = await page.locator(".orgtree__node").count();
  assert.equal(await page.locator(".orgtree__promote").count(), nodeCount - 1);
  assert.equal(await page.getByRole("button", { name: "김회장 승진" }).count(), 0);

  // 정하나(3급, 이팀장 하위) → 승진 → 2급, 이팀장 직속에서 제거
  const leadItem = page.getByRole("treeitem", { name: /이팀장/ }).first();
  const leadDirectChildren = leadItem.locator(
    "xpath=./ul[contains(@class,'orgtree__children')]/li",
  );
  assert.equal(await leadDirectChildren.filter({ hasText: "정하나" }).count(), 1);

  await page.getByRole("button", { name: "정하나 승진" }).click();

  const promoted = page.getByRole("treeitem", { name: /정하나/ }).first();
  assert.match(await promoted.locator(".orgtree__node").first().innerText(), /2급/);
  assert.equal(await leadDirectChildren.filter({ hasText: "정하나" }).count(), 0);
  assert.equal(await page.locator(".orgtree__node").count(), nodeCount);
  await page.screenshot({
    path: fileURLToPath(new URL("desktop-promoted.png", artifacts)),
    fullPage: true,
  });

  await page.setViewportSize({ width: 375, height: 812 });
  await createdNode.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: fileURLToPath(new URL("mobile-created.png", artifacts)),
    fullPage: true,
  });
  assert.deepEqual(browserErrors, []);

  console.log("ORG_CHART_EDITOR PASS");
} finally {
  await browser.close();
}
