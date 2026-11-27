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

async function bodyHasUndefined(page) {
  return page.evaluate(() => (document.body.textContent || "").includes("method.undefined"));
}

/** Reads every invoice row with the raw indexedDB API, bypassing the app. */
async function readInvoices(page) {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open("olaseena-db");
        open.onerror = () => reject(new Error("indexedDB open failed"));
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction("invoices", "readonly");
          const req = tx.objectStore("invoices").getAll();
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(new Error("invoice read failed"));
        };
      }),
  );
}

/** Deletes the payment fields from the stored invoice row, as a v0.1.x row has them. */
async function stripPaymentFields(page) {
  await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open("olaseena-db");
        open.onerror = () => reject(new Error("indexedDB open failed"));
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction("invoices", "readwrite");
          const store = tx.objectStore("invoices");
          const req = store.getAll();
          req.onsuccess = () => {
            const rows = req.result;
            if (rows.length !== 1) {
              reject(new Error(`expected 1 invoice to strip, found ${rows.length}`));
              return;
            }
            const row = rows[0];
            delete row.paymentMethod;
            delete row.paymentDetails;
            store.put(row);
          };
          req.onerror = () => reject(new Error("invoice read failed"));
          tx.oncomplete = () => resolve(true);
          tx.onerror = () => reject(new Error("strip transaction failed"));
        };
      }),
  );
}

function previewDialog(page) {
  return page.locator('[role="dialog"]:has-text("Invoice preview")').last();
}

function detailDialog(page) {
  return page.locator('[role="dialog"]:has-text("Print invoice")').last();
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

  await check("legacy: seed member and cash invoice through the UI", async () => {
    await page.goto(`${BASE}/en/`, { waitUntil: "networkidle" });
    await trackAlerts(page);
    await skipTourIfShown(page);
    await nav(page, "Members");
    await page.getByRole("button", { name: "Add member" }).click();
    await page.getByLabel("Name", { exact: true }).fill("Ayu Lestari");
    await page.getByLabel("Email", { exact: true }).fill("ayu@example.com");
    await page.getByRole("button", { name: "Save changes" }).click();
    await toast(page, "Saved");
    await nav(page, "Invoices");
    await page.getByRole("button", { name: "New invoice" }).click();
    await pickSelect(page, "Member", "Ayu Lestari");
    await pickSelect(page, "Status", "Sent");
    await page.getByLabel("Description", { exact: true }).fill("Piano Basics Nov");
    await page.getByLabel("Amount", { exact: true }).fill("500000");
    await page.getByRole("button", { name: "Create invoice" }).click();
    await toast(page, "Saved");
    const rows = await readInvoices(page);
    if (rows.length !== 1) throw new Error(`expected 1 invoice, found ${rows.length}`);
    if (rows[0].paymentMethod !== "cash") throw new Error(`fresh invoice method is ${rows[0].paymentMethod}, expected cash`);
  });

  await check("legacy: strip the payment fields from the stored row and reload", async () => {
    await stripPaymentFields(page);
    const rows = await readInvoices(page);
    if ("paymentMethod" in rows[0]) throw new Error("paymentMethod still on the stored row after stripping");
    if ("paymentDetails" in rows[0]) throw new Error("paymentDetails still on the stored row after stripping");
    await page.reload({ waitUntil: "networkidle" });
    await skipTourIfShown(page);
  });

  await check("legacy: detail view shows Cash and no method.undefined", async () => {
    await nav(page, "Invoices");
    await page.locator("tr", { hasText: "Ayu Lestari" }).first().click();
    await detailDialog(page).getByRole("button", { name: "Edit invoice" }).waitFor({ timeout: 8000 });
    if (await bodyHasUndefined(page)) throw new Error("detail view shows method.undefined");
    const cash = await detailDialog(page).getByText("Cash").count();
    if (cash < 1) throw new Error("detail view does not show Cash for the legacy invoice");
    if (await detailDialog(page).getByText("Payment details", { exact: true }).count()) {
      throw new Error("detail view shows a payment details block for a cash invoice");
    }
  });

  await check("legacy: print preview shows no payment block and no method.undefined", async () => {
    try {
      await detailDialog(page).getByRole("button", { name: "Print invoice", exact: true }).click();
      await previewDialog(page).getByText("Invoice preview").waitFor({ timeout: 8000 });
      if (await bodyHasUndefined(page)) throw new Error("print preview shows method.undefined");
      if (await previewDialog(page).getByText("Payment details", { exact: true }).count()) {
        throw new Error("print preview shows a payment details block for a cash invoice");
      }
    } finally {
      const close = previewDialog(page).getByRole("button", { name: "Close", exact: true });
      if (await close.count()) await close.click().catch(() => {});
      await detailDialog(page).getByRole("button", { name: "Edit invoice" }).waitFor({ timeout: 8000 });
    }
  });

  await check("legacy: edit starts at Cash and saves transfer with details", async () => {
    await detailDialog(page).getByRole("button", { name: "Edit invoice" }).click();
    const trigger = page.getByRole("combobox", { name: "Payment method", exact: true });
    await trigger.waitFor({ timeout: 8000 });
    if (!((await trigger.textContent()) ?? "").includes("Cash")) {
      throw new Error(`edit form method starts at ${(await trigger.textContent()) ?? ""}, expected Cash`);
    }
    if (await page.getByLabel("Payment details", { exact: true }).count()) {
      throw new Error("edit form shows a details field for cash");
    }
    await pickSelect(page, "Payment method", "Bank transfer");
    await page.getByLabel("Payment details", { exact: true }).fill("BCA 1234567890");
    await page.getByRole("button", { name: "Save changes" }).click();
    await toast(page, "Saved");
    await detailDialog(page).getByText("Bank transfer").waitFor({ timeout: 8000 });
    await detailDialog(page).getByText("BCA 1234567890").waitFor({ timeout: 8000 });
    const rows = await readInvoices(page);
    if (rows[0].paymentMethod !== "transfer") throw new Error(`stored method is ${rows[0].paymentMethod}, expected transfer`);
    if (rows[0].paymentDetails !== "BCA 1234567890") throw new Error("stored details were not saved");
  });

  await check("legacy: recording a transfer payment sets the invoice method", async () => {
    if (!(await detailDialog(page).getByRole("button", { name: "Record payment", exact: true }).count())) {
      await page.keyboard.press("Escape");
      await nav(page, "Invoices");
      await page.locator("tr", { hasText: "Ayu Lestari" }).first().click();
      await detailDialog(page).getByRole("button", { name: "Edit invoice" }).waitFor({ timeout: 8000 });
    }
    await detailDialog(page).getByLabel("Payment amount", { exact: true }).fill("150000");
    await pickSelect(page, "Payment method", "Bank transfer");
    await detailDialog(page).getByRole("button", { name: "Record payment", exact: true }).click();
    await toast(page, "Payment recorded");
    await detailDialog(page).getByText("IDR 150,000").first().waitFor({ timeout: 8000 });
    const rows = await readInvoices(page);
    if (rows[0].paymentMethod !== "transfer") throw new Error(`stored method is ${rows[0].paymentMethod}, expected transfer`);
    if (rows[0].paymentDetails !== "BCA 1234567890") throw new Error("recording a payment changed the details");
  });

  await check("legacy: marking the rest paid keeps the invoice's transfer method", async () => {
    await detailDialog(page).getByRole("button", { name: "Mark as paid" }).click();
    await toast(page, "Payment recorded");
    await detailDialog(page).getByText("Paid").first().waitFor({ timeout: 8000 });
    const rows = await readInvoices(page);
    if (rows[0].paymentMethod !== "transfer") throw new Error(`stored method is ${rows[0].paymentMethod} after Mark as paid, expected transfer`);
    if (rows[0].paidAmount !== 500000) throw new Error(`paid amount is ${rows[0].paidAmount}, expected 500000`);
  });

  await check("legacy: deleting the transfer payment leaves the method at Bank transfer", async () => {
    await detailDialog(page).getByRole("button", { name: "Delete payment" }).first().click();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await toast(page, "Deleted");
    await page.waitForTimeout(500);
    const rows = await readInvoices(page);
    if (rows[0].paymentMethod !== "transfer") throw new Error(`stored method is ${rows[0].paymentMethod} after deleting a payment, expected transfer`);
    if (rows[0].paidAmount !== 350000) throw new Error(`paid amount is ${rows[0].paidAmount}, expected 350000`);
  });

  await check("legacy: Mark as paid on a cash invoice keeps the method at Cash", async () => {
    await detailDialog(page).getByRole("button", { name: "Edit invoice" }).click();
    await pickSelect(page, "Payment method", "Cash");
    await page.getByRole("button", { name: "Save changes" }).click();
    await toast(page, "Saved");
    await detailDialog(page).getByText("Cash", { exact: true }).first().waitFor({ timeout: 8000 });
    await detailDialog(page).getByRole("button", { name: "Mark as paid" }).click();
    await toast(page, "Payment recorded");
    await detailDialog(page).getByText("Paid").first().waitFor({ timeout: 8000 });
    const rows = await readInvoices(page);
    if (rows[0].paymentMethod !== "cash") throw new Error(`stored method is ${rows[0].paymentMethod} after Mark as paid, expected cash`);
    if (rows[0].paidAmount !== 500000) throw new Error(`paid amount is ${rows[0].paidAmount}, expected 500000`);
  });

  await check("legacy: no console errors or page errors", async () => {
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
