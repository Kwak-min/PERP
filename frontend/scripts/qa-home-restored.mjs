import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const apiBase = "http://127.0.0.1:8000/api/v1";
const email = `home-restored-${crypto.randomUUID()}@example.com`;

const signup = await fetch(`${apiBase}/auth/signup`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email, name: "신규 사용자", password: "password-1234" }),
});
assert.equal(signup.status, 201);
const signupBody = await signup.json();

const organization = await fetch(`${apiBase}/tenants`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${signupBody.access_token}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    name: "신규 조직",
    type: "custom",
    modules: ["projects", "tasks", "calendar"],
    departments: [],
  }),
});
assert.equal(organization.status, 201);
const organizationBody = await organization.json();

await mkdir(".artifacts", { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.addInitScript((session) => {
    sessionStorage.setItem("orbitflow.session.v1", JSON.stringify(session));
  }, {
    token: signupBody.access_token,
    orgId: organizationBody.org_id,
    name: "신규 사용자",
    email,
    mustChangePassword: false,
    organizations: [{
      org_id: organizationBody.org_id,
      org_name: "신규 조직",
      org_type: "custom",
      roles: ["owner"],
    }],
  });

  await page.goto("http://127.0.0.1:5199/");
  await page.getByRole("heading", { name: "나의 홈" }).waitFor();
  await page.locator('[data-screen-id="DASH-001"]').waitFor();
  await page.getByRole("region", { name: "나의 홈 지표" }).waitFor();
  assert.equal(await page.getByText("프로젝트 진행률").count(), 0);
  await page.screenshot({ path: ".artifacts/home-restored.png", fullPage: true });
  console.log("HOME RESTORED PASS");
} finally {
  await browser.close();
}
