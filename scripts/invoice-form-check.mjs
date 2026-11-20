/**
 * Browser verification for the invoice form fixes: picking a course fills
 * the first charge from the course title and price, manual charges survive
 * course changes, and the amount label follows the current currency.
 * Serves the static export separately (python3 -m http.server 8901 --directory out)
 * and drives the real UI in Chromium.
 * Run: BASE_URL=http://localhost:8901 node scripts/invoice-form-check.mjs
 * The bundled Chromium is used through its cached executable when the
 * playwright package revision does not match the cache.
 *
 * Checks:
 *   1. seed a trainer, a member, two courses, and enroll the member in both
 *   2. picking a course fills the first charge with its title and price,
 *      the section reads Charges, and the total updates live
 *   3. a manual extra charge adds to the total beside the course charge
 *   4. changing the course refreshes only the filled charge; the manual
 *      charge is untouched
 *   5. clearing the course removes only the filled charge
 *   6. switching currency to EUR (stubbed rate) changes the amount label
 *      to EUR and converts the filled course price
 */
import { chromium } from "playwright";

const BASE = process.env.BASE_URL ?? "http://localhost:8901";
const EXE = `${process.env.HOME}/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome`;

const results = [];
let failures = 0;
let currentPage = null;

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
    if (currentPage) {
      const shot = `${process.env.HOME}/workspace/olaseena-check-shots/${name.replace(/[^a-z0-9]+/gi, "-")}.png`;
      await currentPage.screenshot({ path: shot }).catch(() => {});
      console.log(`  screenshot: ${shot}`);
    }
  }
}

function launchOptions() {
  return { executablePath: EXE, args: ["--no-sandbox"] };
}

async function skipTourIfShown(page) {
  const tour = page.getByText("Get to know Olaseena");
  try {
    // Wait for the tour to appear: checking the count right after load races
    // its first render and leaves the overlay blocking the nav.
    await tour.waitFor({ timeout: 5000 });
  } catch {
    return;
  }
  await page.getByRole("button", { name: "Skip tour" }).click();
  await tour.waitFor({ state: "detached", timeout: 5000 });
  await page.waitForTimeout(600);
}

async function nav(page, name) {
  await page.getByRole("button", { name, exact: true }).first().click();
}

async function toast(page, text) {
  await page.locator('[role="status"]', { hasText: text }).first().waitFor({ timeout: 8000 });
}

/** Radix Select: open the combobox by its accessible name, then pick the option. */
async function pickSelect(page, label, option) {
  const trigger = page.getByRole("combobox", { name: label, exact: true });
  await trigger.click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

async function trackAlerts(page) {
  await page.evaluate(() => {
    window.__alerts = [];
    const mo = new MutationObserver((muts) => {
      for (const m of muts) {
        for (const n of m.addedNodes) {
          if (n.nodeType === 1 && n.getAttribute && n.getAttribute("role") === "alert") {
            window.__alerts.push((n.textContent || "").trim().slice(0, 120));
          }
        }
      }
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
  });
}

async function addCourse(page, title, price) {
  await nav(page, "Courses");
  await page.getByRole("button", { name: "Add course" }).click();
  await page.getByLabel("Title", { exact: true }).fill(title);
  await page.getByLabel("Level", { exact: true }).fill("Beginner");
  await page.getByLabel("Price (IDR)", { exact: true }).fill(String(price));
  await page.getByLabel("Capacity", { exact: true }).fill("10");
  await pickSelect(page, "Trainer", "Budi Santoso");
  await page.getByRole("button", { name: "Save changes" }).click();
  await toast(page, "Saved");
  await page.getByText(title).waitFor();
}

async function enrollMember(page, courseTitle) {
  await nav(page, "Courses");
  await page.locator("tr", { hasText: courseTitle }).first().click();
  await page.getByRole("button", { name: "Enroll member" }).click();
  await pickSelect(page, "Member", "Ayu Lestari");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await toast(page, "Saved");
  await page.getByText("Ayu Lestari").waitFor();
  await page.getByRole("button", { name: "Close", exact: true }).first().click();
}

function createForm(page) {
  return page.locator('[role="dialog"]:has-text("Create invoice")').last();
}

const browser = await chromium.launch(launchOptions());
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  currentPage = page;
  const consoleErrors = [];
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(`console: ${m.text()}`);
  });
  // The currency switch fetches a live rate: answer with a fixed one so the
  // run needs no internet. 500000 IDR at 0.00005 is 25 EUR.
  await page.route((url) => url.hostname.includes("frankfurter.dev"), async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ amount: 1.0, base: "IDR", date: "2026-11-19", rates: { EUR: 0.00005 } }),
    });
  });
  await page.route((url) => url.hostname.includes("exchangerate-api.com"), async (route) => {
    await route.abort();
  });

  await check("form: seed trainer, member, courses, enrollments", async () => {
    await page.goto(`${BASE}/en/`, { waitUntil: "networkidle" });
    await trackAlerts(page);
    await skipTourIfShown(page);
    await nav(page, "Trainers");
    await page.getByRole("button", { name: "Add trainer" }).click();
    await page.getByLabel("Name", { exact: true }).fill("Budi Santoso");
    await page.getByLabel("Email", { exact: true }).fill("budi@example.com");
    await page.getByLabel("Subjects", { exact: true }).fill("Piano");
    await page.getByLabel("Rate per session (IDR)", { exact: true }).fill("150000");
    await page.getByRole("button", { name: "Save changes" }).click();
    await toast(page, "Saved");
    await nav(page, "Members");
    await page.getByRole("button", { name: "Add member" }).click();
    await page.getByLabel("Name", { exact: true }).fill("Ayu Lestari");
    await page.getByLabel("Email", { exact: true }).fill("ayu@example.com");
    await page.getByRole("button", { name: "Save changes" }).click();
    await toast(page, "Saved");
    await addCourse(page, "Piano Basics", 500000);
    await addCourse(page, "Guitar Basics", 300000);
    await enrollMember(page, "Piano Basics");
    await enrollMember(page, "Guitar Basics");
  });

  await check("form: picking a course fills the first charge and the total", async () => {
    await nav(page, "Invoices");
    await page.getByRole("button", { name: "New invoice" }).click();
    const form = createForm(page);
    await form.getByText("Charges").waitFor({ timeout: 8000 });
    // The hint lives in a "?" toggletip whose popover is portaled to the
    // page body, outside the dialog, so it is hovered open and waited on
    // page-wide rather than inside the dialog locator.
    await form.getByRole("button", { name: "More about Charges" }).hover();
    await page.getByText("One charge per row. The total is the sum of the charges.").waitFor();
    await pickSelect(page, "Member", "Ayu Lestari");
    await pickSelect(page, "Course", "Piano Basics");
    const description = form.getByLabel("Description", { exact: true }).first();
    const amount = form.getByLabel("Amount", { exact: true }).first();
    await page.waitForFunction(
      () => document.querySelector('input[aria-label="Description"]')?.value === "Piano Basics",
    );
    if ((await description.inputValue()) !== "Piano Basics") throw new Error(`first charge is ${(await description.inputValue())}, expected Piano Basics`);
    if ((await amount.inputValue()) !== "500000") throw new Error(`first amount is ${(await amount.inputValue())}, expected 500000`);
    await form.getByText("IDR 500,000").waitFor({ timeout: 5000 });
  });

  await check("form: a manual extra charge adds to the total", async () => {
    const form = createForm(page);
    await form.getByRole("button", { name: "Add charge" }).click();
    await form.getByLabel("Description", { exact: true }).nth(1).fill("Book");
    await form.getByLabel("Amount", { exact: true }).nth(1).fill("75000");
    await form.getByText("IDR 575,000").waitFor({ timeout: 5000 });
  });

  await check("form: changing the course refreshes only the filled charge", async () => {
    const form = createForm(page);
    await pickSelect(page, "Course", "Guitar Basics");
    await page.waitForFunction(
      () => document.querySelector('input[aria-label="Description"]')?.value === "Guitar Basics",
    );
    const descriptions = form.getByLabel("Description", { exact: true });
    const amounts = form.getByLabel("Amount", { exact: true });
    if ((await descriptions.nth(0).inputValue()) !== "Guitar Basics") throw new Error("first charge did not refresh to Guitar Basics");
    if ((await amounts.nth(0).inputValue()) !== "300000") throw new Error(`first amount is ${(await amounts.nth(0).inputValue())}, expected 300000`);
    if ((await descriptions.nth(1).inputValue()) !== "Book") throw new Error("manual charge description changed when the course changed");
    if ((await amounts.nth(1).inputValue()) !== "75000") throw new Error("manual charge amount changed when the course changed");
    await form.getByText("IDR 375,000").waitFor({ timeout: 5000 });
  });

  await check("form: clearing the course removes only the filled charge", async () => {
    const form = createForm(page);
    await pickSelect(page, "Course", "Empty");
    await form.getByText("IDR 75,000").waitFor({ timeout: 5000 });
    const descriptions = form.getByLabel("Description", { exact: true });
    if ((await descriptions.count()) !== 1) throw new Error(`expected 1 charge left, found ${await descriptions.count()}`);
    if ((await descriptions.first().inputValue()) !== "Book") throw new Error("the manual charge is not the one left after clearing the course");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
  });

  await check("form: switching to EUR changes the amount label and converts the course price", async () => {
    await nav(page, "Settings");
    await page.getByRole("button", { name: "EUR", exact: true }).click();
    await page.getByText("Switch currency?").waitFor({ timeout: 5000 });
    await page.getByRole("button", { name: "Switch and convert" }).click();
    await toast(page, "Currency switched to EUR");
    await nav(page, "Invoices");
    await page.getByRole("button", { name: "New invoice" }).click();
    const form = createForm(page);
    await form.getByText("EUR", { exact: true }).waitFor({ timeout: 8000 });
    if (await form.getByText("IDR", { exact: true }).count()) throw new Error("amount label still shows IDR after switching to EUR");
    await pickSelect(page, "Member", "Ayu Lestari");
    await pickSelect(page, "Course", "Piano Basics");
    await page.waitForFunction(
      () => document.querySelector('input[aria-label="Description"]')?.value === "Piano Basics",
    );
    const amount = form.getByLabel("Amount", { exact: true }).first();
    if ((await amount.inputValue()) !== "25") throw new Error(`converted amount is ${(await amount.inputValue())}, expected 25`);
    await form.getByText("€25.00").waitFor({ timeout: 5000 });
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
  });

  await check("form: no console errors or page errors", async () => {
    if (consoleErrors.length) throw new Error(consoleErrors.slice(0, 3).join(" | "));
    const alerts = await page.evaluate(() => window.__alerts ?? []);
    if (alerts.length) throw new Error(`error toasts shown: ${alerts.slice(0, 3).join(" | ")}`);
  });

  await context.close();
} finally {
  await browser.close();
}

console.log(`\n${results.length - failures}/${results.length} checks passed`);
process.exit(failures ? 1 : 0);
