import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer as httpServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { randomUUID } from "node:crypto";
import { chromium, expect } from "@playwright/test";
import { startTestServer } from "../../backend/tests/http.js";

process.env.DATABASE_URL = "";
process.env.PG_HOST = "127.0.0.1";
process.env.PG_PORT = "1";
const token = randomUUID();
const projects = new Map();
const server = await startTestServer();
const { pgPool } = await import("../../backend/src/config/pg.js");
const originalQuery = pgPool.query;
const seen = [];
pgPool.query = async (sql, values = []) => {
  seen.push({ sql, values });
  if (sql.includes("FROM auth.sessions s")) return { rows: [{ id: "101", session_id: "session", company_id: "77", name: "PG", email: "pg@example.invalid", account_status: "active", approval_status: "approved", login_at: new Date().toISOString() }] };
  if (sql.includes("FROM org.user_roles")) return { rows: ["project.read", "project.write", "member.read"].map(code => ({ code, role: "configured" })) };
  if (sql.includes("FROM org.company_modules")) return { rows: [{ module_key: "projects" }] };
  if (sql.includes("FROM org.companies")) return { rows: [{ name: "PG company" }] };
  if (sql.includes("INSERT INTO project.projects")) { const id = String(projects.size + 1); projects.set(id, { id, name: values[1], description: values[2], starts_on: values[3], ends_on: values[4] }); return { rows: [{ id }], rowCount: 1 }; }
  if (sql.includes("UPDATE project.projects t")) { const row = projects.get(values[0]); [row.name, row.starts_on, row.ends_on, row.description] = values.slice(2); return { rowCount: 1, rows: [] }; }
  if (sql.includes("DELETE FROM project.projects")) return { rowCount: projects.delete(values[0]) ? 1 : 0, rows: [] };
  if (sql.includes("FROM project.projects t")) return { rows: [projects.get(values[0])] };
  if (sql.includes("FROM project.projects p")) return { rows: [...projects.values()].map(p => ({ __id: p.id, 프로젝트: p.name, status: "active" })) };
  if (sql.includes("FROM org.departments") || sql.includes("FROM org.positions")) return { rows: [] };
  throw new Error(`Unexpected SQL: ${sql}`);
};
const surface = httpServer(async (req, res) => {
  try {
    if (req.url.startsWith("/api/v1/")) {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const response = await fetch(server.baseUrl + req.url.slice("/api/v1".length), { method: req.method, headers: req.headers, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}), signal: AbortSignal.timeout(5000) });
      res.writeHead(response.status, { "content-type": response.headers.get("content-type") ?? "application/json" });
      res.end(Buffer.from(await response.arrayBuffer())); return;
    }
    const file = extname(req.url) ? req.url.slice(1) : "index.html";
    const content = await readFile(new URL(`../dist/${file}`, import.meta.url));
    res.setHeader("content-type", file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html"); res.end(content);
  } catch (error) { res.writeHead(500).end(String(error)); }
});
let browser;
try {
  const ready = once(surface, "listening", { signal: AbortSignal.timeout(5000) }); surface.listen(0, "127.0.0.1"); await ready;
  browser = await chromium.launch({ channel: "chrome" });
  const page = await browser.newPage();
  page.setDefaultTimeout(10000);
  await page.addInitScript(({ token }) => sessionStorage.setItem("orbitflow.session.v1", JSON.stringify({ token, orgId: "pg:77", name: "PG", email: "pg@example.invalid", mustChangePassword: false, organizations: [{ org_id: "pg:77", org_name: "PG company", org_type: "perp_db", roles: ["configured"] }] })), { token });
  await page.goto(`http://127.0.0.1:${surface.address().port}/projects`);
  await expect(page.locator(".filter-bar__result")).toHaveText("0건");
  await page.getByRole("button", { name: "새로 만들기", exact: true }).click();
  await page.getByRole("dialog").getByLabel("이름", { exact: false }).fill("PG_CREATED");
  // Dirty Escape must use the same confirmation path as the close button.
  await Promise.all([
    page.waitForEvent("dialog", { timeout: 3000 }).then(dialog => dialog.dismiss()),
    page.keyboard.press("Escape"),
  ]);
  await expect(page.getByRole("dialog")).toBeVisible();
  const created = page.waitForResponse(r => r.url().endsWith("/api/v1/pg/projects") && r.request().method() === "POST");
  await page.getByRole("dialog").getByRole("button", { name: "만들기", exact: true }).click();
  assert.equal((await created).status(), 201);
  await expect(page.getByRole("cell", { name: "PG_CREATED", exact: true })).toBeVisible();
  await page.reload(); await expect(page.getByRole("cell", { name: "PG_CREATED", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "수정", exact: true }).click();
  await page.getByRole("dialog").getByLabel("이름", { exact: false }).fill("PG_UPDATED");
  const updated = page.waitForResponse(r => r.url().includes("/pg/records/projects/") && r.request().method() === "PATCH");
  await page.getByRole("dialog").getByRole("button", { name: "저장", exact: true }).click(); assert.equal((await updated).status(), 200);
  await expect(page.getByRole("cell", { name: "PG_UPDATED", exact: true })).toBeVisible();
  const deleted = page.waitForResponse(r => r.url().includes("/pg/records/projects/") && r.request().method() === "DELETE");
  await Promise.all([
    page.waitForEvent("dialog", { timeout: 3000 }).then(dialog => dialog.accept()),
    page.getByRole("button", { name: "삭제", exact: true }).click(),
  ]);
  assert.equal((await deleted).status(), 200);
  await expect(page.locator(".filter-bar__result")).toHaveText("0건");
  assert.equal(projects.size, 0); assert.ok(seen.some(q => q.sql.includes("INSERT INTO project.projects") && q.values[0] === "77"));
  console.log("PG_INTEGRATION_BROWSER_PASS (real SPA/HTTP/controllers; isolated SQL-boundary fixture, not real PostgreSQL)");
} finally {
  await browser?.close();
  if (surface.listening) { const closed = once(surface, "close", { signal: AbortSignal.timeout(5000) }); surface.close(); await closed; }
  pgPool.query = originalQuery; await pgPool.end(); await server.close();
}
