import { chromium } from "@playwright/test";

const BASE = "http://127.0.0.1:5173";
const browser = await chromium.launch({ channel: "chrome" });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const logs = [];

async function login() {
  await page.goto(`${BASE}/login`);
  await page.getByLabel("이메일").fill("a@naver.com");
  await page.getByLabel("비밀번호").fill("aaaaaaaa");
  await page.getByRole("button", { name: "로그인" }).click();
  await page.waitForURL((url) => !url.pathname.includes("/login"));
  // keep demo ON (fixture charts render), the observable visualization surface
  await page.evaluate(() => localStorage.setItem("orbitflow.demoMode", "1"));
}

async function gotoRoute(path) {
  await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1600);
  await page.locator("h1").first().waitFor({ timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(400);
  const body = await page.locator("body").innerText();
}

const SURFACES = {
  "/": "DASH-001 home bars",
  "/dashboard/org": "DASH-002 org dashboard",
  "/projects/proj-1/timeline": "TSK-004 gantt",
  "/workload": "TSK-005 heatmap",
  "/admin/billing": "ADM-005 billing dashboard",
  "/vault/graph": "VLT-002 node graph",
  "/automations/auto-1/edit": "AUT-001 flow canvas",
  "/settings/roles": "ORG-004 permission matrix",
  "/agent/brief": "AGT-002 brief",
  "/calendar": "CAL-001 calendar",
  "/finance": "FIN-001 finance dashboard (large values donut)",
  "/analytics/": "ANL-001 analysis",
};

const report = {};
for (const [path, label] of Object.entries(SURFACES)) {
  try {
    await gotoRoute(path);
    const snapshot = await page.evaluate(() => {
      const out = {};
      const grab = (cls) => {
        const el = document.querySelector(`.${cls}`);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return {
          tag: el.tagName, role: el.getAttribute("role"), aria: el.getAttribute("aria-label"),
          text: (el.innerText || "").slice(0, 300), w: Math.round(r.width), h: Math.round(r.height),
        };
      };
      out.bar = grab("bar-chart");
      out.donut = grab("donut");
      out.progress = grab("progress-list");
      out.gantt = grab("gantt");
      out.heatmap = grab("heatmap");
      out.nodegraph = grab("nodegraph");
      out.flow = grab("flowcanvas");
      out.matrix = grab("matrix");
      // gantt bars
      out.ganttBars = [...document.querySelectorAll(".gantt__bar")].map((b) => ({
        text: b.innerText, style: b.getAttribute("style"), rect: ((r) => ({ l: Math.round(r.left), w: Math.round(r.width), r: Math.round(r.right) }))(b.getBoundingClientRect()),
      }));
      out.ganttTrack = (() => { const t = document.querySelector(".gantt__track"); if (!t) return null; const r = t.getBoundingClientRect(); return { l: Math.round(r.left), r: Math.round(r.right), w: Math.round(r.width) }; })();
      // heatmap cells + totals
      out.heatCells = [...document.querySelectorAll(".heatmap__cell")].map((c) => ({ t: c.getAttribute("title"), v: c.innerText, cls: c.className }));
      out.heatTotals = [...document.querySelectorAll(".heatmap__total")].map((c) => ({ v: c.innerText, cls: c.className }));
      // nodegraph
      out.graphLabels = [...document.querySelectorAll(".nodegraph__label")].map((t) => t.textContent);
      out.graphAria = document.querySelector(".nodegraph__svg")?.getAttribute("aria-label");
      out.flowSteps = [...document.querySelectorAll(".flownode")].map((s) => s.innerText);
      out.statCards = [...document.querySelectorAll(".stat-card")].map((s) => s.innerText);
      out.statValues = [...document.querySelectorAll(".stat-card__value")].map((s) => s.innerText);
      out.progressItems = [...document.querySelectorAll(".progress-item")].map((p) => p.innerText);
      out.badges = [...document.querySelectorAll(".section-card")].map((s) => s.querySelector(".section-card__foot")?.innerText ?? null);
      return out;
    });
    report[label] = { path, snapshot };
  } catch (e) {
    report[label] = { path, error: String(e).slice(0, 200) };
  }
}

import { writeFileSync } from "node:fs";
writeFileSync(".artifacts/qa3/QA3-18/survey.json", JSON.stringify(report, null, 2));
console.log("SURVEY_DONE routes=" + Object.keys(report).length);
await browser.close();
