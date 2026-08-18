import { chromium } from "@playwright/test";
import { writeFileSync } from "node:fs";

const BASE = "http://127.0.0.1:5173";
const OUT = ".artifacts/qa3/QA3-18";
const browser = await chromium.launch({ channel: "chrome" });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const out = {};

await page.goto(`${BASE}/login`);
await page.getByLabel("이메일").fill("a@naver.com");
await page.getByLabel("비밀번호").fill("aaaaaaaa");
await page.getByRole("button", { name: "로그인" }).click();
await page.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 15000 });
await page.evaluate(() => localStorage.setItem("orbitflow.demoMode", "1"));

async function visit(path, name) {
  await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  await page.locator("h1").first().waitFor({ timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(300);
}

// ---- VLT-002 node graph a11y ----
await visit("/vault/graph", "vlt");
out.vltGraph = await page.evaluate(() => {
  const svg = document.querySelector(".nodegraph__svg");
  const labels = [...document.querySelectorAll(".nodegraph__label")].map((t) => t.textContent);
  const edgeLines = document.querySelectorAll(".nodegraph__edge").length;
  return {
    svgRole: svg?.getAttribute("role"),
    svgAria: svg?.getAttribute("aria-label"),
    labels, edgeLines,
    allAriaLabels: [...document.querySelectorAll("[aria-label]")].map((e) => e.getAttribute("aria-label")).filter(Boolean),
  };
});
await page.screenshot({ path: `${OUT}/E_VLT_graph.png` });

// ---- Gantt milestone overflow (last task start+span == total) ----
await visit("/projects/proj-1/timeline", "gantt");
out.gantt = await page.evaluate(() => {
  const track = document.querySelector(".gantt__track");
  const tr = track?.getBoundingClientRect();
  const bars = [...document.querySelectorAll(".gantt__row")].map((row, i) => {
    const bar = row.querySelector(".gantt__bar");
    const ms = row.querySelector(".gantt__milestone");
    const br = bar?.getBoundingClientRect();
    const mr = ms?.getBoundingClientRect();
    return {
      task: row.querySelector(".gantt__label-col b")?.textContent,
      bar: br ? { l: Math.round(br.left - (tr?.left||0)), r: Math.round(br.right - (tr?.left||0)), w: Math.round(br.width) } : null,
      barText: bar?.querySelector(".gantt__bar-text")?.textContent,
      barTextR: bar?.querySelector(".gantt__bar-text")?.getBoundingClientRect() ? Math.round(bar.querySelector(".gantt__bar-text").getBoundingClientRect().right - (tr?.left||0)) : null,
      barRectR: br ? Math.round(br.right - (tr?.left||0)) : null,
      milestone: ms ? { l: Math.round(mr.left - (tr?.left||0)), r: Math.round(mr.right - (tr?.left||0)) } : null,
      milestoneOverflowRight: ms && tr ? Math.round(mr.right - tr.right) : null,
    };
  });
  const gantt = document.querySelector(".gantt");
  return {
    ganttRole: gantt?.getAttribute("role"),
    ganttAria: gantt?.getAttribute("aria-label"),
    trackW: tr ? Math.round(tr.width) : null,
    trackL: tr ? Math.round(tr.left) : null,
    trackR: tr ? Math.round(tr.right) : null,
    bars,
  };
});
await page.screenshot({ path: `${OUT}/E_GANTT.png` });

// ---- FIN-001 donut large values ----
await visit("/finance", "fin");
out.finDonut = await page.evaluate(() => {
  const ring = document.querySelector(".donut__ring");
  const hole = document.querySelector(".donut__hole");
  const legend = [...document.querySelectorAll(".donut__legend li")].map((li) => li.innerText);
  return {
    center: hole?.querySelector("strong")?.textContent,
    centerLabel: hole?.querySelector("small")?.textContent,
    legend,
    ringBg: ring?.style.background,
    chartAria: document.querySelector(".donut")?.getAttribute("aria-label"),
    scrollX: document.querySelector(".screen")?.scrollWidth,
    clientX: document.querySelector(".screen")?.clientWidth,
    barVals: [...document.querySelectorAll(".bar-chart__col")].map((c) => ({ label: c.querySelector(".bar-chart__label")?.textContent, barStyle: c.querySelector(".bar-chart__bar")?.getAttribute("style") })).slice(0, 3),
  };
});
await page.screenshot({ path: `${OUT}/E_FIN_donut.png` });

// ---- DASH-002 org dashboard bar+donut ----
await visit("/dashboard/org", "dash2");
out.dash2 = await page.evaluate(() => {
  return {
    bar: (() => {
      const b = document.querySelector(".bar-chart");
      const aria = b?.getAttribute("aria-label");
      const cols = [...document.querySelectorAll(".bar-chart__col")].map((c) => ({
        label: c.querySelector(".bar-chart__label")?.textContent,
        height: c.querySelector(".bar-chart__bar")?.getAttribute("style"),
        valueVisible: !!c.querySelector(".bar-chart__value, .bar-chart__num"),
      }));
      return { aria, cols };
    })(),
    donut: {
      center: document.querySelector(".donut__hole strong")?.textContent,
      centerLabel: document.querySelector(".donut__hole small")?.textContent,
      legend: [...document.querySelectorAll(".donut__legend li")].map((li) => li.innerText),
      aria: document.querySelector(".donut")?.getAttribute("aria-label"),
      progress: [...document.querySelectorAll(".progress-item")].map((p) => p.innerText),
    },
  };
});
await page.screenshot({ path: `${OUT}/E_DASH2.png` });

// ---- Calendar a11y ----
await visit("/calendar", "cal");
out.calendar = await page.evaluate(() => {
  const grid = document.querySelector(".calendar__grid");
  const firstEvent = document.querySelector(".calendar__event");
  return {
    gridRole: grid?.getAttribute("role"),
    calendarAria: document.querySelector(".calendar")?.getAttribute("aria-label"),
    cells: document.querySelectorAll(".calendar__cell").length,
    eventAria: firstEvent?.getAttribute("aria-label"),
    eventTitle: firstEvent?.getAttribute("title"),
    eventRole: firstEvent?.getAttribute("role"),
    eventTag: firstEvent?.tagName,
    navAria: [...document.querySelectorAll(".calendar-nav button")].map((b) => b.getAttribute("aria-label")),
    todayCell: document.querySelector(".calendar__cell--today") ? "exists" : "none",
  };
});
await page.screenshot({ path: `${OUT}/E_CAL.png` });

// ---- Heatmap ----
await visit("/workload", "heat");
out.heatmap = await page.evaluate(() => {
  const hm = document.querySelector(".heatmap");
  const cols = getComputedStyle(hm).gridTemplateColumns;
  return {
    role: hm?.getAttribute("role"),
    aria: hm?.getAttribute("aria-label"),
    gridTemplateColumns: cols,
    totals: [...document.querySelectorAll(".heatmap__total")].map((c) => ({ v: c.innerText, cls: c.className })),
    headCols: [...document.querySelectorAll(".heatmap__head .heatmap__tick")].map((t) => t.textContent),
  };
});
await page.screenshot({ path: `${OUT}/E_HEAT.png` });

writeFileSync(`${OUT}/evidence.json`, JSON.stringify(out, null, 2));
console.log("EVIDENCE_DONE");
await browser.close();
