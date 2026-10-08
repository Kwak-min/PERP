import { chromium } from "@playwright/test";
const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push("page:" + e.message));
page.on("console", (m) => { if (m.type() === "error") errors.push("console:" + m.text()); });
try {
  await page.goto("http://127.0.0.1:5173/", { waitUntil: "networkidle", timeout: 20000 });
  console.log("URL:", page.url());
  console.log("title:", await page.title());
  const bodyText = await page.locator("body").innerText();
  console.log("body text len:", bodyText.length);
  console.log("body snippet:", bodyText.slice(0, 200).replace(/\n/g, " | "));
  console.log("root children:", await page.locator("#root").locator(":scope > *").count());
  console.log("JS errors:", errors.join(" | ") || "none");
  await page.screenshot({ path: "qa-probe-shot.png" });
} catch (e) {
  console.log("PROBE_FAIL:", e.message.split("\n")[0]);
} finally {
  await browser.close();
}