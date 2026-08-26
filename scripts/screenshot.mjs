/**
 * Capture landing + dashboard screenshots into docs/screenshots/.
 * Expects Service Runner to already be listening on 127.0.0.1:4780.
 */
import { chromium } from "playwright";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "docs", "screenshots");
mkdirSync(outDir, { recursive: true });

const cfgPath = join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "ServiceRunner", "config.json");
if (!existsSync(cfgPath)) {
  console.error("Service Runner config not found. Start the app first.");
  process.exit(1);
}
const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
const base = `http://127.0.0.1:${cfg.port || 4780}`;

const browser = await chromium.launch({
  headless: true,
  channel: process.env.SR_BROWSER || "msedge",
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });

await page.goto(base + "/", { waitUntil: "domcontentloaded" });
await page.waitForSelector(".hero-title");
await page.mouse.move(720, 280);
await page.waitForTimeout(700);
await page.screenshot({ path: join(outDir, "landing.png"), fullPage: true });
console.log("wrote docs/screenshots/landing.png");

await page.goto(base + "/dashboard.html", { waitUntil: "domcontentloaded" });
await page.waitForSelector(".status-panel");
await page.waitForSelector(".card");
await page.mouse.move(420, 260);
await page.waitForTimeout(1600);
await page.evaluate(() => {
  const el = document.getElementById("prompt-text");
  if (el) el.textContent = el.textContent.replace(/Bearer \S+/g, "Bearer <token>");
});
await page.screenshot({ path: join(outDir, "dashboard.png"), fullPage: true });
console.log("wrote docs/screenshots/dashboard.png");

const card = page.locator(".card").first();
if (await card.count()) {
  await card.locator('[data-act="logs"]').click();
  await page.waitForSelector("#drawer:not([hidden])");
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(outDir, "logs.png") });
  console.log("wrote docs/screenshots/logs.png");
  await page.locator("#btn-close-drawer").click();
  await page.waitForTimeout(200);
}

await page.locator("#btn-add").click();
await page.waitForSelector("#modal-bg:not([hidden])");
await page.waitForTimeout(300);
await page.screenshot({ path: join(outDir, "add-service.png") });
console.log("wrote docs/screenshots/add-service.png");

await browser.close();
