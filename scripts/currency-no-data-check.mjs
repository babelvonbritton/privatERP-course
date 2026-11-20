/**
 * Browser verification for the currency no-data switch rule.
 * Serves the static export separately (python3 -m http.server 8901 --directory out)
 * and drives the real UI in Chromium.
 * Run: BASE_URL=http://localhost:8901 node scripts/currency-no-data-check.mjs
 * The bundled Chromium is used through its cached executable when the
 * playwright package revision does not match the cache.
 *
 * Check 1, empty database: switching currency makes no request to the rate
 * sources, shows no warning dialog, and still changes the currency.
 * Check 2, seeded database: switching currency shows the warning dialog,
 * fetches a rate (fulfilled here with a fixed rate, so the run needs no
 * internet), and the converted amount lands in the UI.
 */
import { chromium } from "playwright";

const BASE = process.env.BASE_URL ?? "http://localhost:8901";
const EXE = `${process.env.HOME}/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome`;

const results = [];
let failures = 0;

async function check(name, fn) {
  const started = Date.now();
  try {
    await fn();
    const line = `PASS  ${name} (${Date.now() - started}ms)`;
    results.push(line);
    console.log(line);
  } catch (e) {
    failures += 1;
    const detail = String(e?.message ?? e)
      .split("\n")
      .slice(0, 6)
      .join(" | ");
    const line = `FAIL  ${name} :: ${detail}`;
    results.push(line);
    console.log(line);
  }
}

function launchOptions() {
  return { executablePath: EXE, args: ["--no-sandbox"] };
}

async function skipTourIfShown(page) {
  const tour = page.getByText("Get to know Olaseena");
  if (await tour.count()) {
    await page.getByRole("button", { name: "Skip tour" }).click();
    await tour.waitFor({ state: "detached", timeout: 5000 });
    // Let the tour backdrop finish its exit before touching the page.
    await page.waitForTimeout(600);
  }
}

async function nav(page, name) {
  const button = page.getByRole("button", { name, exact: true }).first();
  try {
    await button.click({ timeout: 5000 });
  } catch {
    // The tour overlay sometimes outlives the tour text: dismiss it if it
    // is still there, then try the navigation once more.
    await skipTourIfShown(page);
    await button.click({ timeout: 5000 });
  }
}

async function toast(page, text) {
  await page.locator('[role="status"]', { hasText: text }).first().waitFor({ timeout: 8000 });
}

async function currencyIs(page, code) {
  await nav(page, "Settings");
  const current = page.locator('button[aria-current="true"]');
  await current.waitFor({ timeout: 5000 });
  const label = (await current.textContent()) ?? "";
  if (label.trim() !== code) throw new Error(`current currency button shows ${label.trim()}, expected ${code}`);
}

async function emptyDatabase(browser) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const rateRequests = [];
  // Any rate request is a failure here: record it and stop it. The matcher
  // is a function, so the host match is exact and not a glob guess.
  await page.route((url) => url.hostname.includes("frankfurter.dev"), async (route) => {
    rateRequests.push(route.request().url());
    await route.abort();
  });
  await page.route((url) => url.hostname.includes("exchangerate-api.com"), async (route) => {
    rateRequests.push(route.request().url());
    await route.abort();
  });

  await check("empty database: switch currency makes no rate request", async () => {
    await page.goto(`${BASE}/en/`, { waitUntil: "networkidle" });
    await skipTourIfShown(page);
    await nav(page, "Settings");
    await page.getByRole("button", { name: "EUR", exact: true }).click();
    // The switch must land at once: give the dialog a moment to appear, then
    // require that it never did.
    await page.waitForTimeout(1000);
    if (await page.getByText("Switch currency?").count()) {
      throw new Error("warning dialog appeared on an empty database");
    }
    await toast(page, "Currency switched to EUR");
    if (rateRequests.length) throw new Error(`rate requests fired: ${rateRequests.join(", ")}`);
    await currencyIs(page, "EUR");
  });

  await check("empty database: currency stays switched after reload", async () => {
    await page.reload({ waitUntil: "networkidle" });
    await skipTourIfShown(page);
    await currencyIs(page, "EUR");
    if (rateRequests.length) throw new Error(`rate requests fired: ${rateRequests.join(", ")}`);
  });

  await context.close();
}

async function seededDatabase(browser) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const rateRequests = [];
  // Fulfill the rate with a fixed value so the run needs no internet and the
  // converted amount is predictable: 150000 IDR at 0.00005 is 7.50 EUR.
  // The matcher is a function, so the host match is exact and not a glob guess.
  await page.route((url) => url.hostname.includes("frankfurter.dev"), async (route) => {
    rateRequests.push(route.request().url());
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ base: "IDR", rates: { EUR: 0.00005 } }),
    });
  });
  await page.route((url) => url.hostname.includes("exchangerate-api.com"), async (route) => {
    rateRequests.push(route.request().url());
    await route.abort();
  });

  await check("seeded database: switch currency fetches a rate and converts", async () => {
    await page.goto(`${BASE}/en/`, { waitUntil: "networkidle" });
    await skipTourIfShown(page);
    await nav(page, "Trainers");
    // Let the screen finish loading its data before touching its buttons:
    // the first render is replaced once storage is ready.
    await page.waitForTimeout(500);
    await page.getByRole("button", { name: "Add trainer" }).click();
    await page.getByLabel("Name", { exact: true }).fill("Budi Santoso");
    await page.getByLabel("Email", { exact: true }).fill("budi@example.com");
    await page.getByLabel("Subjects", { exact: true }).fill("Piano");
    await page.getByLabel("Rate per session (IDR)", { exact: true }).fill("150000");
    await page.getByRole("button", { name: "Save changes" }).click();
    await toast(page, "Saved");
    await page.getByText("Budi Santoso").waitFor();

    await nav(page, "Settings");
    await page.getByRole("button", { name: "EUR", exact: true }).click();
    await page.getByText("Switch currency?").waitFor({ timeout: 5000 });
    await page.getByRole("button", { name: "Switch and convert" }).click();
    await toast(page, "Currency switched to EUR");
    if (!rateRequests.length) throw new Error("no rate request was made with data present");
    await nav(page, "Trainers");
    await page.getByText("€7.50").first().waitFor({ timeout: 5000 });
  });

  await context.close();
}

const browser = await chromium.launch(launchOptions());
try {
  await emptyDatabase(browser);
  await seededDatabase(browser);
} finally {
  await browser.close();
}

console.log(`\n${results.length - failures}/${results.length} checks passed`);
process.exit(failures ? 1 : 0);
