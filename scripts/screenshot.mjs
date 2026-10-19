/**
 * Capture the README screenshots into docs/screenshots/ from demo data.
 * Starts scripts/demo-server.mjs (ports 4798/4799) — never touches a running Service Runner.
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "docs", "screenshots");
mkdirSync(outDir, { recursive: true });

const demo = spawn(process.execPath, [join(here, "demo-server.mjs")], { stdio: ["ignore", "pipe", "inherit"] });
await new Promise((resolve, reject) => {
  let seen = "";
  demo.stdout.on("data", (d) => {
    seen += d;
    if (seen.includes("4798") && seen.includes("4799")) resolve();
  });
  demo.once("exit", (code) => reject(new Error(`demo server exited (${code}) — are ports 4798/4799 free?`)));
});

const browser = await chromium.launch({ headless: true, channel: process.env.SR_BROWSER || "msedge" });
const open = async (url) => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 860 }, deviceScaleFactor: 1, colorScheme: "dark" });
  return { ctx, page: await ctx.newPage(), url };
};

try {
  {
    const { ctx, page } = await open();
    await page.goto("http://127.0.0.1:4799/dashboard.html");
    await page.waitForSelector(".svc");
    await page.click('.svc[data-id="notes"] .svc-name');
    await page.waitForTimeout(1500);
    await page.screenshot({ path: join(outDir, "control-panel.png") });
    console.log("wrote docs/screenshots/control-panel.png");
    await ctx.close();
  }
  {
    const { ctx, page } = await open();
    await page.goto("http://127.0.0.1:4798/");
    await page.evaluate(() =>
      fetch("/_portal/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: "demo-access-token", deviceName: "Edge on Windows" }),
      }),
    );
    await page.reload();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: join(outDir, "portal-home.png") });
    console.log("wrote docs/screenshots/portal-home.png");
    await ctx.close();
  }
} finally {
  await browser.close();
  demo.kill();
}
