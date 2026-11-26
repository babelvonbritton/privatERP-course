/**
 * Browser verification for Olaseena v1.0.1.
 * Serves the static export separately (python3 -m http.server 8901 --directory out)
 * and drives the real UI in Chromium: desktop 1280x800 and mobile 390x844.
 * Run: BASE_URL=http://localhost:8901 node scripts/browser-check.mjs
 * The bundled Chromium is used through its cached executable when the
 * playwright package revision does not match the cache.
 */
import { chromium } from "playwright";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { strFromU8, unzipSync } from "fflate";

mkdirSync(`${process.env.HOME}/workspace/olaseena-check-shots`, { recursive: true });
let currentPage = null;

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

async function noOverflow(page, label, expectedWidth) {
  const v = await page.evaluate(() => ({
    sw: document.documentElement.scrollWidth,
    iw: window.innerWidth,
  }));
  // Compare against the intended viewport width, not innerWidth: on mobile
  // Chromium expands innerWidth to fit overflowing content, which would
  // make the check pass spuriously while the page is actually too wide.
  const vw = expectedWidth ?? v.iw;
  if (v.sw > vw) throw new Error(`horizontal overflow on ${label}: scrollWidth ${v.sw} > viewport ${vw}`);
  if (v.iw !== vw) throw new Error(`viewport expanded on ${label}: innerWidth ${v.iw} != ${vw}`);
}

/** Feature 4: at max scroll the page footer must sit fully above the fixed bottom bar. */
async function footerClearOfNav(page) {
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(400);
  const v = await page.evaluate(() => {
    const nav = document.querySelector("nav.fixed");
    const footer = document.querySelector("footer");
    const nr = nav?.getBoundingClientRect();
    const fr = footer?.getBoundingClientRect();
    return { navTop: nr ? Math.round(nr.top) : null, footerBottom: fr ? Math.round(fr.bottom) : null };
  });
  if (v.footerBottom === null || v.navTop === null) throw new Error("footer or bottom nav not found");
  if (v.footerBottom > v.navTop) {
    throw new Error(`footer bottom ${v.footerBottom} sits behind the bottom nav (top ${v.navTop})`);
  }
}

/** Feature 4: every control enlarged for touch must actually render at least 44px tall. */
async function fixedTargetsAtLeast44(page, label) {
  const small = await page.evaluate(() => {
    const bad = [];
    for (const el of document.querySelectorAll("button")) {
      const cls = typeof el.className === "string" ? el.className : "";
      if (!cls.includes("max-sm:min-h-11") && !cls.includes("max-sm:size-11") && !cls.includes("max-sm:h-11")) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.bottom < 0 || r.top > window.innerHeight) continue;
      if (r.height < 44) bad.push(`${(el.getAttribute("aria-label") || el.textContent.trim()).slice(0, 30)} ${Math.round(r.height)}px`);
    }
    return bad;
  });
  if (small.length) throw new Error(`${label}: enlarged controls still below 44px: ${small.join("; ")}`);
}

/** Radix Select: open the combobox by its accessible name, then pick the option. */
async function pickSelect(page, label, option) {
  const trigger = page.getByRole("combobox", { name: label, exact: true });
  await trigger.click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

/** TagInput: type a skill into the tagged field and confirm it with Enter. */
async function addRequiredSkill(page, skill) {
  await page.getByLabel("Required skills", { exact: true }).fill(skill);
  await page.keyboard.press("Enter");
}

/** The Attendance session picker shares its "Course" label with the dashboard filter below it; the picker is the first of the two. */
async function pickSessionCourse(page, option) {
  await page.getByRole("combobox", { name: "Course", exact: true }).first().click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

/** TimePicker: open the picker by its field label, then pick the hour and the minute. */
async function pickTime(page, label, time) {
  const [hour, minute] = time.split(":");
  await page.getByRole("button", { name: label, exact: true }).click();
  // Scope to the open panel: a closing panel stays mounted for its exit animation, so an unscoped query can match two.
  const panel = page.locator(".anim-pop[data-state='open']");
  await panel.getByRole("group", { name: "Hour" }).getByRole("button", { name: hour, exact: true }).click();
  await panel.getByRole("group", { name: "Minute" }).getByRole("button", { name: minute, exact: true }).click();
  // Picking a minute closes the panel; wait until it is gone so the next pick sees only one panel.
  await panel.waitFor({ state: "detached", timeout: 5000 }).catch(() => {});
}

async function pickDate(page, date) {
  // The DatePicker is a popover calendar with no text input: open it, step
  // to the target month, then click the in-month day button. Out-of-month
  // spillover days share the number, so the in-month class disambiguates.
  await page.getByLabel("Date", { exact: true }).click();
  const panel = page.locator(".anim-pop[data-state='open']");
  await panel.waitFor();
  const targetMonth = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric" }).format(date);
  for (let i = 0; i < 12; i++) {
    const label = (await panel.locator("span.capitalize").first().textContent())?.trim();
    if (label === targetMonth) break;
    await panel.getByRole("button", { name: "Next month" }).click();
  }
  const day = date.getDate();
  const clicked = await panel.evaluate((el, d) => {
    const btns = [...el.querySelectorAll("button")].filter(
      (b) => b.textContent.trim() === String(d) && b.className.includes("text-ink"),
    );
    if (btns.length !== 1) return btns.length;
    btns[0].click();
    return 1;
  }, day);
  if (clicked !== 1) throw new Error(`expected 1 in-month day button for ${day}, got ${clicked}`);
  await panel.waitFor({ state: "detached", timeout: 5000 }).catch(() => {});
}

async function nav(page, name) {
  await page.getByRole("button", { name, exact: true }).first().click();
}

async function toast(page, text, role = "status") {
  // Match by DOM attribute, not by ARIA role: while a Radix dialog is open,
  // Radix hides the rest of the page (including the toaster) from the
  // accessibility tree, so getByRole("status") sees zero toasts even though
  // they are rendered and visible on screen.
  await page.locator(`[role="${role}"]`, { hasText: text }).first().waitFor({ timeout: 8000 });
}

/** Records every error toast (role=alert) into window.__alerts for the final check. */
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

/** The next `count` Mon/Wed/Fri dates after today, as Date objects. */
function upcomingSlotDates(count) {
  const out = [];
  const d = new Date();
  d.setDate(d.getDate() + 1);
  while (out.length < count) {
    const day = d.getDay();
    if (day === 1 || day === 3 || day === 5) out.push(new Date(d));
    d.setDate(d.getDate() + 1);
  }
  return out;
}

/** Today's invoice-number prefix, e.g. INV-20261125. */
function invoicePrefix() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `INV-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

const MORE_NAV = new Set(["Trainers", "Attendance", "Payroll", "Trash", "Settings"]);

/** Mobile nav: bottom-bar items directly, the rest behind the More sheet. */
async function navMobile(page, name) {
  if (MORE_NAV.has(name)) {
    await page.getByRole("button", { name: "More", exact: true }).click();
    await page.getByRole("button", { name, exact: true }).click();
  } else {
    await nav(page, name);
  }
}

/** Creates one Piano Basics session with Budi Santoso; `date` null keeps today. */
async function createSession(page, topic, date, onMobile) {
  if (onMobile) await navMobile(page, "Attendance");
  else await nav(page, "Attendance");
  await pickSessionCourse(page, "Piano Basics");
  await page.getByRole("button", { name: "New session" }).click();
  if (date) await pickDate(page, date);
  await page.getByLabel("Topic", { exact: true }).fill(topic);
  await pickTime(page, "Start time", "10:00");
  await pickTime(page, "End time", "11:30");
  await page.getByRole("radio", { name: "Budi Santoso" }).click();
  await page.getByRole("button", { name: "Add", exact: true }).last().click();
  await toast(page, "Saved");
}

/** Creates one Sent invoice for the given member. */
async function createInvoice(page, memberName, description, amount, onMobile) {
  if (onMobile) await navMobile(page, "Invoices");
  else await nav(page, "Invoices");
  await page.getByRole("button", { name: "New invoice" }).click();
  await pickSelect(page, "Member", memberName);
  await pickSelect(page, "Status", "Sent");
  await page.getByLabel("Description", { exact: true }).fill(description);
  await page.getByLabel("Amount", { exact: true }).fill(String(amount));
  await page.getByRole("button", { name: "Create invoice" }).click();
  await toast(page, "Saved");
}

/** Dashboard pagination + latest-three invoices, shared by desktop and mobile. */
async function assertDashboardPagination(page, width, page1Topics, page2Topics) {
  if (width === 390) await navMobile(page, "Dashboard");
  else await nav(page, "Dashboard");
  const upcoming = page.locator("section").filter({ has: page.getByRole("heading", { name: "Upcoming sessions" }) });
  await upcoming.getByText("Page 1 of 2").waitFor();
  if ((await upcoming.locator("li").count()) !== 5) {
    throw new Error(`expected 5 upcoming sessions on page 1, got ${await upcoming.locator("li").count()}`);
  }
  for (const topic of page1Topics) await upcoming.getByText(topic).waitFor();
  await upcoming.getByRole("button", { name: "Next" }).click();
  await upcoming.getByText("Page 2 of 2").waitFor();
  if ((await upcoming.locator("li").count()) !== page2Topics.length) {
    throw new Error(`expected ${page2Topics.length} upcoming session(s) on page 2, got ${await upcoming.locator("li").count()}`);
  }
  for (const topic of page2Topics) await upcoming.getByText(topic).waitFor();
  await upcoming.getByRole("button", { name: "Previous" }).click();
  await upcoming.getByText("Page 1 of 2").waitFor();
  await noOverflow(page, `dashboard pagination ${width}`, width);

  const invoices = page.locator("section").filter({ has: page.getByRole("heading", { name: "Recent invoices" }) });
  if ((await invoices.locator("tbody tr").count()) !== 3) {
    throw new Error(`expected 3 recent invoices, got ${await invoices.locator("tbody tr").count()}`);
  }
  const prefix = invoicePrefix();
  for (const n of ["002", "003", "004"]) await invoices.getByText(`${prefix}-${n}`).waitFor();
  if ((await invoices.getByText(`${prefix}-001`).count()) !== 0) {
    throw new Error("oldest invoice still shown in the latest-three list");
  }
  await invoices.getByRole("button", { name: "View all" }).click();
  await page.getByRole("button", { name: "New invoice" }).waitFor();
}

async function desktop(browser) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    acceptDownloads: true,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  currentPage = page;
  const consoleErrors = [];
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(`console: ${m.text()}`);
  });

  await check("desktop: dashboard loads", async () => {
    await page.goto(`${BASE}/en`, { waitUntil: "networkidle" });
    await trackAlerts(page);
    await page.getByRole("button", { name: "Dashboard", exact: true }).first().waitFor();
    await noOverflow(page, "dashboard", 1280);
  });

  await check("desktop: first-run tour shows and Skip ends it", async () => {
    await page.getByText("Get to know Olaseena").waitFor({ timeout: 8000 });
    await page.getByRole("button", { name: "Skip tour" }).click();
    await page.getByText("Get to know Olaseena").waitFor({ state: "detached", timeout: 5000 });
  });


  await check("desktop: business profile reminder and quick setup", async () => {
    await page.getByText("Set up your business profile").waitFor();
    await page.getByRole("button", { name: "Quick setup" }).click();
    const dlg = page.getByRole("dialog");
    await dlg.getByRole("heading", { name: "Business profile" }).waitFor();
    // Saving without a name shows the error and stays in the dialog.
    await dlg.getByRole("button", { name: "Save changes" }).click();
    await dlg.getByText("Enter a business name to save the profile.").waitFor();
    await dlg.getByLabel("Business name", { exact: true }).fill("Melody Studio");
    await dlg.getByLabel("Owner's name", { exact: true }).fill("Rina Hartono");
    await dlg.getByLabel("Business tagline", { exact: true }).fill("Music lessons for every age");
    await dlg.getByLabel("Business address", { exact: true }).fill("Jl. Melati 12, Bandung");
    await dlg.getByLabel("Business contacts", { exact: true }).fill("081234567890");
    await page.keyboard.press("Enter");
    await dlg.getByRole("button", { name: "Save changes" }).click();
    await toast(page, "Saved");
    await page.getByRole("dialog").waitFor({ state: "detached" });
    // The reminder is gone once a business name is saved, and the dashboard is still the current screen.
    if (await page.getByText("Set up your business profile").count()) throw new Error("profile reminder still shown after saving a business name");
    await page.getByRole("heading", { name: "Dashboard" }).waitFor();
    await noOverflow(page, "dashboard profile reminder", 1280);
  });

  await check("desktop: add member, search, edit", async () => {
    await nav(page, "Members");
    await page.getByText("No members yet").waitFor();
    await page.getByRole("button", { name: "Add member" }).click();
    await page.getByLabel("Name", { exact: true }).fill("Ayu Lestari");
    await page.getByLabel("Email", { exact: true }).fill("ayu@example.com");
    await page.getByLabel("Phone", { exact: true }).fill("081234567890");
    await page.getByRole("button", { name: "Save changes" }).click();
    await toast(page, "Saved");
    await page.getByText("Ayu Lestari").waitFor();
    await page.getByPlaceholder("Search by name, email, or phone").fill("Ayu");
    await page.getByText("Ayu Lestari").waitFor();
    await page.getByPlaceholder("Search by name, email, or phone").fill("zzz-no-match");
    await page.getByText("No members yet").waitFor();
    await page.getByPlaceholder("Search by name, email, or phone").fill("");
    await page.getByText("Ayu Lestari").waitFor();
    await noOverflow(page, "members", 1280);
  });

  await check("desktop: delete member with confirm", async () => {
    try {
      await page.getByRole("button", { name: "Add member" }).click();
      await page.getByLabel("Name", { exact: true }).fill("Temp Delete");
      await page.getByRole("button", { name: "Save changes" }).click();
      await toast(page, "Saved");
      await page.locator("tr", { hasText: "Temp Delete" }).getByRole("button", { name: "Delete member" }).click();
      await page.getByRole("button", { name: "Delete", exact: true }).click();
      await toast(page, "Temp Delete moved to the trash bin");
      if (await page.locator("tr", { hasText: "Temp Delete" }).count()) throw new Error("deleted member still listed");
    } finally {
      const cancel = page.getByRole("button", { name: "Cancel", exact: true });
      if (await cancel.count()) await cancel.first().click().catch(() => {});
    }
  });

  await check("desktop: add trainer", async () => {
    await nav(page, "Trainers");
    await page.getByRole("button", { name: "Add trainer" }).click();
    await page.getByLabel("Name", { exact: true }).fill("Budi Santoso");
    await page.getByLabel("Email", { exact: true }).fill("budi@example.com");
    await page.getByLabel("Subjects", { exact: true }).fill("Piano");
    await page.keyboard.press("Enter");
    await page.getByLabel("Rate per session (IDR)", { exact: true }).fill("150000");
    await page.getByRole("button", { name: "Save changes" }).click();
    await toast(page, "Saved");
    await page.getByText("Budi Santoso").waitFor();
    await noOverflow(page, "trainers", 1280);
  });

  await check("desktop: add course and enroll member", async () => {
    try {
      await nav(page, "Courses");
      await page.getByRole("button", { name: "Add course" }).click();
      await page.getByLabel("Title", { exact: true }).fill("Piano Basics");
      await page.getByLabel("Level", { exact: true }).fill("Beginner");
      await page.getByLabel("Price (IDR)", { exact: true }).fill("500000");
      await addRequiredSkill(page, "Piano");
      await page.getByRole("checkbox", { name: "Mon" }).check();
      await page.getByRole("checkbox", { name: "Wed" }).check();
      await page.getByRole("checkbox", { name: "Fri" }).check();
      await page.getByRole("button", { name: "Save changes" }).click();
      await toast(page, "Saved");
      await page.locator("tr", { hasText: "Piano Basics" }).click();
      await page.getByText("Enrollments").first().waitFor();
      await page.getByText("Mon, Wed, Fri").waitFor();
      await page.getByRole("button", { name: "Enroll member" }).click();
      await pickSelect(page, "Member", "Ayu Lestari");
      await page.getByRole("button", { name: "Add", exact: true }).last().click();
      await toast(page, "Saved");
      await page.getByText("Ayu Lestari").waitFor();
    } finally {
      // Close the course detail modal even when an assertion above failed,
      // so a stuck modal cannot block every later nav click.
      const close = page.getByRole("button", { name: "Close" });
      if (await close.count()) await close.first().click().catch(() => {});
    }
    await noOverflow(page, "courses", 1280);
  });

  await check("desktop: create session and mark attendance", async () => {
    await nav(page, "Attendance");
    await pickSessionCourse(page, "Piano Basics");
    await page.getByRole("button", { name: "New session" }).click();
    await page.getByLabel("Topic", { exact: true }).fill("Scales");
    await pickTime(page, "Start time", "10:00");
    await pickTime(page, "End time", "11:30");
    await page.getByRole("radio", { name: "Budi Santoso" }).click();
    await page.getByRole("button", { name: "Add", exact: true }).last().click();
    await toast(page, "Saved");
    await page.locator("p", { hasText: "Scales" }).waitFor();
    await page.getByText("10:00–11:30 (1.5 h)").first().waitFor();
    await page.getByRole("radiogroup", { name: "Ayu Lestari" }).getByRole("radio", { name: "Present" }).click();
    await page.getByRole("switch", { name: "Trainer present" }).click();
    await page.getByRole("button", { name: "Mark attendance" }).click();
    await toast(page, "Attendance saved");
    await noOverflow(page, "attendance", 1280);
  });

  await check("desktop: session list below the course table drives assignment and drops marked sessions", async () => {
    // A second enrolled member, so the assignment can narrow the list.
    await nav(page, "Members");
    await page.getByRole("button", { name: "Add member" }).click();
    await page.getByLabel("Name", { exact: true }).fill("Citra Kirana");
    await page.getByLabel("Email", { exact: true }).fill("citra@example.com");
    await page.getByLabel("Phone", { exact: true }).fill("081234567892");
    await page.getByRole("button", { name: "Save changes" }).click();
    await toast(page, "Saved");
    try {
      await nav(page, "Courses");
      await page.locator("tr", { hasText: "Piano Basics" }).click();
      await page.getByText("Enrollments").first().waitFor();
      await page.getByRole("button", { name: "Enroll member" }).click();
      await pickSelect(page, "Member", "Citra Kirana");
      await page.getByRole("button", { name: "Add", exact: true }).last().click();
      await toast(page, "Saved");
    } finally {
      const close = page.getByRole("button", { name: "Close" });
      if (await close.count()) await close.first().click().catch(() => {});
    }
    const pending = page.locator("section").filter({ has: page.getByRole("heading", { name: "Sessions" }) });
    // Scales was marked in the attendance check, so it has already left the list.
    await nav(page, "Courses");
    await pending.getByRole("heading", { name: "Sessions" }).waitFor();
    if (await pending.getByText("Scales").count()) {
      throw new Error("marked session Scales is still listed in the Sessions section");
    }
    // A fresh session on a Monday or Wednesday past the dashboard check's
    // five slot dates, so it cannot collide with them. Piano Basics meets
    // Mondays and Wednesdays; the slot helper also returns Fridays.
    const farCourseDay = upcomingSlotDates(8)
      .filter((d) => d.getDay() === 1 || d.getDay() === 3)
      .pop();
    try {
      await createSession(page, "Arpeggios", farCourseDay, false);
      await nav(page, "Courses");
      await pending.getByText("Arpeggios").waitFor();
      // The row names the course the session belongs to.
      await pending.getByText("Piano Basics").waitFor();
      // A fresh session lists every enrolled member.
      await pending.getByText("All enrolled members").waitFor();
      await pending.getByRole("button", { name: "Assign members" }).click();
      await pending.getByRole("checkbox", { name: "Ayu Lestari" }).check();
      await pending.getByRole("button", { name: "Save changes" }).click();
      await toast(page, "Saved");
      await pending.getByText("Assigned: Ayu Lestari").waitFor();
    } finally {
      const close = page.getByRole("button", { name: "Close" });
      if (await close.count()) await close.first().click().catch(() => {});
    }
    // The attendance list now shows only the assigned member.
    await nav(page, "Attendance");
    await pickSessionCourse(page, "Piano Basics");
    await page.getByRole("combobox", { name: "Sessions", exact: true }).click();
    await page.getByRole("option", { name: "Arpeggios" }).click();
    await page.getByText("Only the assigned members are listed here.").waitFor();
    await page.getByRole("radiogroup", { name: "Ayu Lestari" }).waitFor();
    if (await page.getByRole("radiogroup", { name: "Citra Kirana" }).count()) {
      throw new Error("unassigned member Citra Kirana is listed in the attendance marking");
    }
    // Unchecking every member returns the session to unassigned, and both
    // enrolled members are listed again.
    await nav(page, "Courses");
    await pending.getByText("Arpeggios").waitFor();
    await pending.getByRole("button", { name: "Assign members" }).click();
    await pending.getByRole("checkbox", { name: "Ayu Lestari" }).uncheck();
    await pending.getByRole("button", { name: "Save changes" }).click();
    await toast(page, "Saved");
    await pending.getByText("All enrolled members").waitFor();
    await nav(page, "Attendance");
    await pickSessionCourse(page, "Piano Basics");
    await page.getByRole("combobox", { name: "Sessions", exact: true }).click();
    await page.getByRole("option", { name: "Arpeggios" }).click();
    await page.getByRole("radiogroup", { name: "Ayu Lestari" }).waitFor();
    await page.getByRole("radiogroup", { name: "Citra Kirana" }).waitFor();
    // Marking the session drops it from the Sessions section. The trainer
    // stays absent, so the payroll and trainer-detail checks that follow
    // still see exactly one present session.
    await page.getByRole("radiogroup", { name: "Ayu Lestari" }).getByRole("radio", { name: "Present" }).click();
    await page.getByRole("radiogroup", { name: "Citra Kirana" }).getByRole("radio", { name: "Present" }).click();
    await page.getByRole("button", { name: "Mark attendance" }).click();
    await toast(page, "Attendance saved");
    await nav(page, "Courses");
    await pending.getByRole("heading", { name: "Sessions" }).waitFor();
    if (await pending.getByText("Arpeggios").count()) {
      throw new Error("marked session Arpeggios is still listed in the Sessions section");
    }
    // Clean up: delete the check session so the dashboard pagination check
    // that follows sees only the sessions it creates itself.
    const detailDialog = page.locator('[role="dialog"]', { hasText: "Piano Basics" });
    try {
      await page.locator("tr", { hasText: "Piano Basics" }).click();
      await page.getByText("Enrollments").first().waitFor();
      const row = detailDialog.locator("li", { hasText: "Arpeggios" });
      await row.getByRole("button", { name: "Delete session" }).click();
      await page.getByRole("button", { name: "Delete", exact: true }).click();
      // The confirm is an AlertDialog layered above the detail dialog: wait
      // for it to leave before touching the detail dialog's own close, or
      // the click lands while the detail is still hidden behind it.
      await page.locator('[role="alertdialog"]').waitFor({ state: "detached", timeout: 5000 });
      await row.waitFor({ state: "detached", timeout: 8000 });
      await detailDialog.getByRole("button", { name: "Close" }).click();
      await detailDialog.waitFor({ state: "detached", timeout: 5000 });
    } finally {
      const close = page.getByRole("button", { name: "Close" });
      if (await close.count()) await close.first().click().catch(() => {});
    }
    await noOverflow(page, "attendance-assigned", 1280);
  });

  await check("desktop: course detail enrollment and session lists scroll independently", async () => {
    try {
      await nav(page, "Courses");
      await page.locator("tr", { hasText: "Piano Basics" }).click();
      await page.getByText("Enrollments").first().waitFor();
      const lists = await page.evaluate(() => {
        const modal = document.querySelector('[role="dialog"]');
        return [...(modal?.querySelectorAll("ul") ?? [])].map((ul) => {
          const cs = getComputedStyle(ul);
          return { overflowY: cs.overflowY, maxHeight: cs.maxHeight };
        });
      });
      if (lists.length !== 2) throw new Error(`expected 2 scrollable lists in the course detail, found ${lists.length}`);
      for (const [i, s] of lists.entries()) {
        if (s.overflowY !== "auto") throw new Error(`course detail list ${i} does not scroll (overflow-y ${s.overflowY})`);
        if (s.maxHeight !== "320px") throw new Error(`course detail list ${i} max-height is ${s.maxHeight}, expected 320px`);
      }
    } finally {
      const close = page.getByRole("button", { name: "Close" });
      if (await close.count()) await close.first().click().catch(() => {});
    }
    await noOverflow(page, "courses", 1280);
  });

  await check("desktop: member detail shows attended hours per course", async () => {
    try {
      await nav(page, "Members");
      await page.locator("tr", { hasText: "Ayu Lestari" }).click();
      await page.getByText("Enrollments").first().waitFor();
      await page.getByText("1.5 h").waitFor();
    } finally {
      const close = page.getByRole("button", { name: "Close" });
      if (await close.count()) await close.first().click().catch(() => {});
    }
    await noOverflow(page, "members", 1280);
  });

  await check("desktop: attendance dashboard below marking, filters narrow rows, pagination present", async () => {
    // A second member with no attendance, so a filter can narrow to zero rows.
    await nav(page, "Members");
    await page.getByRole("button", { name: "Add member" }).click();
    await page.getByLabel("Name", { exact: true }).fill("Benny");
    await page.getByLabel("Email", { exact: true }).fill("benny@example.com");
    await page.getByLabel("Phone", { exact: true }).fill("081234567891");
    await page.getByRole("button", { name: "Save changes" }).click();
    await toast(page, "Saved");

    await nav(page, "Attendance");
    await pickSessionCourse(page, "Piano Basics");
    await page.getByRole("heading", { name: "Attendance summary" }).waitFor();
    const positions = await page.evaluate(() => {
      const heading = [...document.querySelectorAll("h2")].find((h) => h.textContent === "Attendance summary");
      const mark = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Mark attendance");
      return { headingTop: heading?.getBoundingClientRect().top ?? -1, markTop: mark?.getBoundingClientRect().top ?? -1 };
    });
    if (positions.headingTop <= positions.markTop) {
      throw new Error("attendance dashboard is not below the marking section");
    }
    const dashboard = page.locator('section[aria-label="Attendance summary"]');
    const pickDashboardSelect = async (label, option) => {
      await dashboard.getByRole("combobox", { name: label, exact: true }).click();
      await page.getByRole("option", { name: option, exact: true }).click();
    };
    await dashboard.locator("tbody tr").first().waitFor();
    if ((await dashboard.locator("tbody tr").count()) !== 1) {
      throw new Error("expected 1 dashboard row before filtering");
    }
    await dashboard.getByText("1.5 h").first().waitFor();
    await page.getByText("Page 1 of 1").waitFor();
    await page.getByRole("button", { name: "Previous" }).waitFor();
    await page.getByRole("button", { name: "Next" }).waitFor();
    await pickDashboardSelect("Member", "Benny");
    await page.getByText("No attendance records yet.").waitFor();
    await pickDashboardSelect("Member", "All");
    await dashboard.locator("tbody tr").first().waitFor();
    if ((await dashboard.locator("tbody tr").count()) !== 1) {
      throw new Error("expected 1 dashboard row after resetting the member filter");
    }
    await pickDashboardSelect("Course", "Piano Basics");
    await dashboard.locator("tbody tr").first().waitFor();
    if ((await dashboard.locator("tbody tr").count()) !== 1) {
      throw new Error("expected 1 dashboard row after filtering by course");
    }
    await page.getByRole("tab", { name: "Trainers" }).click();
    await dashboard.locator("tbody tr").first().waitFor();
    if ((await dashboard.locator("tbody tr").count()) !== 1) {
      throw new Error("expected 1 trainer dashboard row");
    }
    await dashboard.getByText("Budi Santoso").first().waitFor();
    await dashboard.getByText("1.5 h").first().waitFor();
    if ((await dashboard.getByRole("combobox", { name: "Member", exact: true }).count()) !== 0) {
      throw new Error("member filter is shown on the trainer tab");
    }
    await pickDashboardSelect("Course", "Piano Basics");
    await dashboard.locator("tbody tr").first().waitFor();
    if ((await dashboard.locator("tbody tr").count()) !== 1) {
      throw new Error("expected 1 trainer dashboard row after filtering by course");
    }
    await page.getByRole("tab", { name: "Members" }).click();
    await dashboard.locator("tbody tr").first().waitFor();
    await noOverflow(page, "attendance-dashboard", 1280);
  });

  await check("desktop: create invoice, partial then full payment", async () => {
    try {
      await nav(page, "Invoices");
      await page.getByRole("button", { name: "New invoice" }).click();
      await pickSelect(page, "Member", "Ayu Lestari");
      await pickSelect(page, "Status", "Sent");
      // The create form already ships with one empty line-item row; filling
      // it is enough. Adding another row would leave an empty row behind,
      // and the form rejects empty line descriptions.
      await page.getByLabel("Description", { exact: true }).fill("Piano Basics Nov");
      await page.getByLabel("Amount", { exact: true }).fill("500000");
      await page.getByRole("button", { name: "Create invoice" }).click();
      await toast(page, "Saved");
      await page.getByText("Piano Basics Nov").waitFor({ timeout: 5000 }).catch(() => {});
      await page.locator("tr", { hasText: "Ayu Lestari" }).first().click();
      await page.getByRole("button", { name: "Record payment", exact: true }).waitFor();
      await page.getByLabel("Payment amount", { exact: true }).fill("200000");
      await page.getByRole("button", { name: "Record payment", exact: true }).click();
      await toast(page, "Payment recorded");
      await page.getByText("Partially paid").first().waitFor();
      await page.getByLabel("Payment amount", { exact: true }).fill("300000");
      await page.getByRole("button", { name: "Record payment", exact: true }).click();
      await toast(page, "Payment recorded");
      await page.getByText("Paid").first().waitFor();
    } finally {
      const close = page.getByRole("button", { name: "Close" });
      if (await close.count()) await close.first().click().catch(() => {});
    }
    await noOverflow(page, "invoices", 1280);
  });


  await check("desktop: printed invoice shows the business profile, not the owner", async () => {
    try {
      await nav(page, "Invoices");
      await page.locator("tr", { hasText: "Ayu Lestari" }).first().click();
      await page.getByRole("button", { name: "Print invoice", exact: true }).click();
      const doc = page.getByTestId("invoice-document");
      await doc.getByText("Melody Studio").waitFor();
      await doc.getByText("Music lessons for every age").waitFor();
      await doc.getByText("Jl. Melati 12, Bandung").waitFor();
      await doc.getByText("081234567890").waitFor();
      if (await doc.getByText("Rina Hartono").count()) throw new Error("owner name shown on the invoice");
      await noOverflow(page, "printed invoice profile", 1280);
    } finally {
      // Two modals can be stacked here (detail, then print): close the top one first.
      const close = page.getByRole("button", { name: "Close" });
      if (await close.count()) await close.last().click().catch(() => {});
      await page.waitForTimeout(300);
      if (await close.count()) await close.first().click().catch(() => {});
    }
  });

  await check("desktop: payroll excludes an absent session, refreshes a draft run, and lists paid and unpaid sessions", async () => {
    try {
      // The run starts from the session marked present in the attendance check.
      await nav(page, "Payroll");
      await pickSelect(page, "Trainer", "Budi Santoso");
      await page.getByRole("button", { name: "Generate pay run" }).click();
      await toast(page, "Saved");
      await page.locator("tr", { hasText: "Budi Santoso" }).click();
      await page.getByText("Review pay run").waitFor();
      await page.getByText("IDR 150,000").first().waitFor();
      await page.getByText("Paid sessions").waitFor();
      await page.getByText("Scales").first().waitFor();
      await page.getByRole("button", { name: "Close" }).first().click();

      // Mark the trainer absent: regenerating the draft run must drop the session.
      await nav(page, "Attendance");
      await pickSessionCourse(page, "Piano Basics");
      await page.getByRole("combobox", { name: "Sessions", exact: true }).click();
      await page.getByRole("option", { name: "Scales" }).click();
      await page.getByRole("switch", { name: "Trainer present" }).click();
      await page.waitForFunction(() => document.querySelector('[role="switch"]')?.getAttribute("aria-checked") === "false");
      await nav(page, "Payroll");
      await pickSelect(page, "Trainer", "Budi Santoso");
      await page.getByRole("button", { name: "Generate pay run" }).click();
      await toast(page, "Saved");
      await page.locator("tr", { hasText: "Budi Santoso" }).click();
      await page.getByText("Review pay run").waitFor();
      await page.getByText("IDR 0").first().waitFor();
      await page.getByText("Unpaid sessions").waitFor();
      await page.getByText("Scales").first().waitFor();
      await page.getByRole("button", { name: "Close" }).first().click();

      // Mark the trainer present again: the draft run refreshes back to one paid session.
      await nav(page, "Attendance");
      await pickSessionCourse(page, "Piano Basics");
      await page.getByRole("combobox", { name: "Sessions", exact: true }).click();
      await page.getByRole("option", { name: "Scales" }).click();
      await page.getByRole("switch", { name: "Trainer present" }).click();
      await page.waitForFunction(() => document.querySelector('[role="switch"]')?.getAttribute("aria-checked") === "true");
      await nav(page, "Payroll");
      await pickSelect(page, "Trainer", "Budi Santoso");
      await page.getByRole("button", { name: "Generate pay run" }).click();
      await toast(page, "Saved");
      await page.locator("tr", { hasText: "Budi Santoso" }).click();
      await page.getByText("Review pay run").waitFor();
      await page.getByText("IDR 150,000").first().waitFor();
      await page.getByRole("button", { name: "Mark as paid" }).click();
      await toast(page, "Saved");
      await page.getByText("Budi Santoso").first().waitFor();
    } finally {
      const close = page.getByRole("button", { name: "Close" });
      if (await close.count()) await close.first().click().catch(() => {});
    }
    await noOverflow(page, "payroll", 1280);
  });

  await check("desktop: trainer detail shows hours taught per course", async () => {
    try {
      await nav(page, "Trainers");
      await page.locator("tr", { hasText: "Budi Santoso" }).click();
      await page.getByText("1 session · 1.5 h").first().waitFor();
      await page.getByText("Total: 1 session · 1.5 h").waitFor();
    } finally {
      const close = page.getByRole("button", { name: "Close" });
      if (await close.count()) await close.first().click().catch(() => {});
    }
    await noOverflow(page, "trainers", 1280);
  });

  await check("desktop: dashboard reflects the day's work", async () => {
    await nav(page, "Dashboard");
    await page.getByText("IDR 500,000").first().waitFor();
    await page.getByText("100%").waitFor();
    await noOverflow(page, "dashboard", 1280);
  });

  await check("desktop: dashboard upcoming sessions paginate 5 per page, invoices show latest 3", async () => {
    // One session (Scales, today) and one invoice (-001) already exist.
    const dates = upcomingSlotDates(5);
    const topics = ["Dash S2", "Dash S3", "Dash S4", "Dash S5", "Dash S6"];
    for (let i = 0; i < 5; i++) await createSession(page, topics[i], dates[i], false);
    for (let i = 2; i <= 4; i++) await createInvoice(page, "Ayu Lestari", `Dashboard check ${i}`, 100000 * i, false);
    await assertDashboardPagination(page, 1280, ["Scales", "Dash S2", "Dash S3", "Dash S4", "Dash S5"], ["Dash S6"]);
  });

  await check("desktop: language switch to Indonesian and back", async () => {
    await nav(page, "Settings");
    await page.locator('a[href="/id/"]').first().click();
    await page.waitForURL("**/id/**");
    await page.getByRole("button", { name: "Dasbor", exact: true }).first().waitFor();
    await page.locator('a[href="/en/"]').first().click();
    await page.waitForURL("**/en/**");
    await page.getByRole("button", { name: "Dashboard", exact: true }).first().waitFor();
  });


  await check("desktop: business profile section is first in Settings and keeps the saved name", async () => {
    await nav(page, "Settings");
    const headings = await page.locator("main h2").allTextContents();
    if (headings[0] !== "Business profile") throw new Error(`first Settings section is ${headings[0]}, expected Business profile`);
    const value = await page.getByLabel("Business name", { exact: true }).inputValue();
    if (value !== "Melody Studio") throw new Error(`saved business name not shown in Settings: ${value}`);
    await noOverflow(page, "settings profile", 1280);
  });

  await check("desktop: backup downloads a zip", async () => {
    await nav(page, "Settings");
    await page.getByRole("button", { name: "Backup and restore" }).click();
    const downloadPromise = page.waitForEvent("download", { timeout: 15000 });
    await page.getByRole("button", { name: "Create backup" }).click();
    const download = await downloadPromise;
    await page.getByText("Backup saved").waitFor({ timeout: 15000 });
    const path = await download.path();
    if (!path) throw new Error("download has no path");
    const size = statSync(path).size;
    if (size < 100) throw new Error(`backup zip too small: ${size} bytes`);
    if (!download.suggestedFilename().startsWith("olaseena-")) {
      throw new Error(`unexpected backup name: ${download.suggestedFilename()}`);
    }
    await page.getByRole("button", { name: "Close" }).click();
  });

  await check("desktop: Drive section renders with sign-in gated actions disabled", async () => {
    await nav(page, "Settings");
    await page.getByRole("heading", { name: "Google Drive" }).waitFor();
    await page.getByText("Not connected").waitFor();
    const backupBtn = page.getByRole("button", { name: "Back up to Drive" });
    const restoreBtn = page.getByRole("button", { name: "Restore from Drive" });
    const connectBtn = page.getByRole("button", { name: "Connect Google Drive" });
    if (!(await backupBtn.isDisabled())) throw new Error("Back up to Drive is enabled while signed out");
    if (!(await restoreBtn.isDisabled())) throw new Error("Restore from Drive is enabled while signed out");
    if (await connectBtn.isDisabled()) throw new Error("Connect Google Drive is disabled while signed out");
    const syncToggle = page.getByRole("switch", { name: /Auto-sync to Drive/ });
    if ((await syncToggle.getAttribute("aria-checked")) !== "false") throw new Error("auto-sync is on by default");
    if (!(await syncToggle.isDisabled())) throw new Error("auto-sync toggle is enabled while signed out");
    await page.getByText("Connect Google Drive to turn on auto-sync.").waitFor();
    await noOverflow(page, "drive section", 1280);
  });

  await check("desktop: sync setup dialog opens, cancels, and reaches the download step", async () => {
    // Seed a connected Drive session (fake token) so the sync toggle is clickable.
    await page.evaluate(() => new Promise((resolve, reject) => {
      const req = indexedDB.open("olaseena-db");
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction("settings", "readwrite");
        const store = tx.objectStore("settings");
        store.put({ key: "drive.accessToken", value: "check-token" });
        store.put({ key: "drive.tokenExpiresAt", value: Date.now() + 3600_000 });
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
      req.onerror = () => reject(req.error);
    }));
    await page.reload({ waitUntil: "networkidle" });
    await nav(page, "Settings");
    await page.getByText("Connected", { exact: true }).waitFor();
    const syncToggle = page.getByRole("switch", { name: /Auto-sync to Drive/ });
    // No passphrase stored yet: turning it on opens the setup dialog.
    await syncToggle.click();
    const dlg = page.getByRole("dialog");
    await dlg.getByRole("heading", { name: "Set up auto-sync" }).waitFor();
    // Cancel turns the toggle back off and stores nothing.
    await dlg.getByRole("button", { name: "Cancel" }).click();
    await page.getByRole("dialog").waitFor({ state: "detached" });
    if ((await syncToggle.getAttribute("aria-checked")) !== "false") throw new Error("sync toggle stayed on after Cancel");
    // A valid passphrase reaches the download step.
    await syncToggle.click();
    await dlg.getByRole("heading", { name: "Set up auto-sync" }).waitFor();
    await dlg.getByLabel("Backup passphrase", { exact: true }).fill("CheckPass123");
    await dlg.getByLabel("Confirm backup passphrase", { exact: true }).fill("CheckPass123");
    await dlg.getByRole("button", { name: "Confirm" }).click();
    await dlg.getByRole("heading", { name: "Save your passphrase" }).waitFor();
    await noOverflow(page, "sync setup dialog", 1280);
    const downloadPromise = page.waitForEvent("download", { timeout: 15000 });
    await dlg.getByRole("button", { name: "Download passphrase (JSON)" }).click();
    const download = await downloadPromise;
    if (download.suggestedFilename() !== "olaseena-drive-passphrase.json") {
      throw new Error(`unexpected passphrase download name: ${download.suggestedFilename()}`);
    }
    const path = await download.path();
    if (!path) throw new Error("passphrase download has no path");
    const content = JSON.parse(readFileSync(path, "utf8"));
    if (content.passphrase !== "CheckPass123") throw new Error("downloaded JSON does not contain the passphrase");
    if (content.app !== "Olaseena" || content.type !== "drive-backup-passphrase") {
      throw new Error("downloaded JSON metadata is wrong");
    }
    // Done closes the dialog with sync on; then switch it back off so no
    // sync is scheduled against this fake session later in the run.
    await dlg.getByRole("button", { name: "Done" }).click();
    await page.getByRole("dialog").waitFor({ state: "detached" });
    if ((await syncToggle.getAttribute("aria-checked")) !== "true") throw new Error("sync toggle is off after setup");
    await syncToggle.click();
    // Turning off writes state and re-renders, so wait for the flip instead
    // of reading the attribute in the same tick as the click.
    await page.waitForFunction(
      (el) => el.getAttribute("aria-checked") === "false",
      await syncToggle.elementHandle(),
      { timeout: 5000 },
    );
  });

  await check("desktop: tour replay advances and skips", async () => {
    await nav(page, "Settings");
    await page.getByRole("button", { name: "Get to know the features" }).click();
    await page.getByText("Get to know Olaseena").waitFor({ timeout: 5000 });
    // Scope to the tour dialog: the dashboard behind it has its own "Next"
    // pagination button, and an unscoped click is a strict-mode race.
    await page.getByRole("dialog").getByRole("button", { name: "Next" }).click();
    await page.getByText("Get to know Olaseena").waitFor();
    await page.getByRole("button", { name: "Skip tour" }).click();
    await page.getByText("Get to know Olaseena").waitFor({ state: "detached", timeout: 5000 });
  });

  await check("desktop: privacy page loads", async () => {
    await page.goto(`${BASE}/en/privacy`, { waitUntil: "networkidle" });
    await page.getByText("Privacy & Policy").first().waitFor();
    await noOverflow(page, "privacy", 1280);
  });

  await check("desktop: terms page loads in English and Indonesian", async () => {
    await page.goto(`${BASE}/en/terms`, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "Terms of Service" }).waitFor();
    await noOverflow(page, "terms en", 1280);
    await page.goto(`${BASE}/id/terms`, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "Ketentuan Layanan" }).waitFor();
    await noOverflow(page, "terms id", 1280);
  });

  await check("desktop: no console errors or page errors", async () => {
    if (consoleErrors.length) throw new Error(consoleErrors.slice(0, 3).join(" | "));
    const alerts = await page.evaluate(() => window.__alerts ?? []);
    if (alerts.length) throw new Error(`error toasts shown: ${alerts.slice(0, 3).join(" | ")}`);
  });

  await context.close();
  return consoleErrors;
}

async function mobile(browser) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    acceptDownloads: true,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  currentPage = page;
  const consoleErrors = [];
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(`console: ${m.text()}`);
  });

  await check("mobile: loads and tour skips", async () => {
    await page.goto(`${BASE}/en`, { waitUntil: "networkidle" });
    await trackAlerts(page);
    await page.getByText("Get to know Olaseena").waitFor({ timeout: 8000 });
    await page.getByRole("button", { name: "Skip tour" }).click();
    await page.getByText("Get to know Olaseena").waitFor({ state: "detached", timeout: 5000 });
    await noOverflow(page, "mobile dashboard", 390);
  });


  await check("mobile: business profile reminder and quick setup", async () => {
    await page.getByText("Set up your business profile").waitFor();
    await page.getByRole("button", { name: "Quick setup" }).click();
    const dlg = page.getByRole("dialog");
    await dlg.getByRole("heading", { name: "Business profile" }).waitFor();
    await dlg.getByLabel("Business name", { exact: true }).fill("Mobile Studio");
    await dlg.getByRole("button", { name: "Save changes" }).click();
    await toast(page, "Saved");
    await page.getByRole("dialog").waitFor({ state: "detached" });
    if (await page.getByText("Set up your business profile").count()) throw new Error("profile reminder still shown after saving");
    await noOverflow(page, "mobile profile reminder", 390);
  });

  await check("mobile: add a member through the bottom nav", async () => {
    await nav(page, "Members");
    await page.getByRole("button", { name: "Add member" }).click();
    await page.getByLabel("Name", { exact: true }).fill("Mobile User");
    await page.getByLabel("Email", { exact: true }).fill("mobile@example.com");
    await page.getByRole("button", { name: "Save changes" }).click();
    await toast(page, "Saved");
    await page.getByText("Mobile User").waitFor();
    await noOverflow(page, "mobile members", 390);
  });

  await check("mobile: dashboard upcoming sessions paginate 5 per page, invoices show latest 3", async () => {
    // Seed the trainer and course the dashboard data needs (member "Mobile User" already exists).
    await navMobile(page, "Trainers");
    await page.getByRole("button", { name: "Add trainer" }).click();
    await page.getByLabel("Name", { exact: true }).fill("Budi Santoso");
    await page.getByLabel("Email", { exact: true }).fill("budi@example.com");
    await page.getByLabel("Subjects", { exact: true }).fill("Piano");
    await page.keyboard.press("Enter");
    await page.getByLabel("Rate per session (IDR)", { exact: true }).fill("150000");
    await page.getByRole("button", { name: "Save changes" }).click();
    await toast(page, "Saved");
    await navMobile(page, "Courses");
    await page.getByRole("button", { name: "Add course" }).click();
    await page.getByLabel("Title", { exact: true }).fill("Piano Basics");
    await page.getByLabel("Level", { exact: true }).fill("Beginner");
    await page.getByLabel("Price (IDR)", { exact: true }).fill("500000");
    await addRequiredSkill(page, "Piano");
    await page.getByRole("checkbox", { name: "Mon" }).check();
    await page.getByRole("checkbox", { name: "Wed" }).check();
    await page.getByRole("checkbox", { name: "Fri" }).check();
    await page.getByRole("button", { name: "Save changes" }).click();
    await toast(page, "Saved");
    const dates = upcomingSlotDates(5);
    const topics = ["Mobile S2", "Mobile S3", "Mobile S4", "Mobile S5", "Mobile S6"];
    await createSession(page, "Mobile S1", null, true);
    for (let i = 0; i < 5; i++) await createSession(page, topics[i], dates[i], true);
    for (let i = 1; i <= 4; i++) await createInvoice(page, "Mobile User", `Mobile check ${i}`, 100000 * i, true);
    await assertDashboardPagination(page, 390, ["Mobile S1", "Mobile S2", "Mobile S3", "Mobile S4", "Mobile S5"], ["Mobile S6"]);
  });

  for (const [navName, overflowLabel] of [
    ["Courses", "mobile courses"],
    ["Invoices", "mobile invoices"],
  ]) {
    await check(`mobile: ${navName} screen, no overflow`, async () => {
      await nav(page, navName);
      await noOverflow(page, overflowLabel, 390);
    });
  }

  for (const [moreName, overflowLabel] of [
    ["Trainers", "mobile trainers"],
    ["Attendance", "mobile attendance"],
    ["Payroll", "mobile payroll"],
    ["Settings", "mobile settings"],
  ]) {
    await check(`mobile: ${moreName} via More sheet, no overflow`, async () => {
      await page.getByRole("button", { name: "More", exact: true }).click();
      await page.getByRole("button", { name: moreName, exact: true }).click();
      await noOverflow(page, overflowLabel, 390);
    });
  }

  await check("mobile: no console errors or page errors", async () => {
    if (consoleErrors.length) throw new Error(consoleErrors.slice(0, 3).join(" | "));
    const alerts = await page.evaluate(() => window.__alerts ?? []);
    if (alerts.length) throw new Error(`error toasts shown: ${alerts.slice(0, 3).join(" | ")}`);
  });

  await context.close();
  return consoleErrors;
}

/** Feature 4: the mobile tour is a bottom sheet docked above the bottom bar. */
async function mobileTourSheet(browser) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  currentPage = page;

  await check("mobile tour: sheet docks above the bottom nav on all 12 steps", async () => {
    await page.goto(`${BASE}/en`, { waitUntil: "networkidle" });
    await page.getByText("Get to know Olaseena").waitFor({ timeout: 8000 });
    await page.waitForTimeout(500);
    for (let i = 0; i < 12; i++) {
      const state = await page.evaluate(() => {
        const dlg = document.querySelector('[role="dialog"]');
        const dr = dlg?.getBoundingClientRect();
        const nav = document.querySelector("nav.fixed");
        const nr = nav?.getBoundingClientRect();
        const h1 = document.querySelector("main h1");
        const hr = h1?.getBoundingClientRect();
        const grabber = dlg?.querySelector("div[aria-hidden='true'].rounded-full");
        const dim = [...document.querySelectorAll("div")].find(
          (d) => getComputedStyle(d).backgroundColor === "rgba(43, 30, 43, 0.35)",
        );
        const skip = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Skip tour");
        const sr = skip?.getBoundingClientRect();
        const next = [...document.querySelectorAll("button")].find((b) => ["Next", "Finish"].includes(b.textContent.trim()));
        const nrect = next?.getBoundingClientRect();
        return {
          left: dr ? Math.round(dr.left) : null,
          right: dr ? Math.round(dr.right) : null,
          top: dr ? Math.round(dr.top) : null,
          bottom: dr ? Math.round(dr.bottom) : null,
          height: dr ? Math.round(dr.height) : null,
          vh: window.innerHeight,
          vw: window.innerWidth,
          navTop: nr ? Math.round(nr.top) : null,
          titleBottom: hr ? Math.round(hr.bottom) : null,
          hasGrabber: !!grabber,
          hasLightDim: !!dim,
          hasRing: !!dlg?.parentElement?.querySelector(".border-white"),
          skipH: sr ? Math.round(sr.height) : null,
          nextH: nrect ? Math.round(nrect.height) : null,
          nextBottom: nrect ? Math.round(nrect.bottom) : null,
        };
      });
      if (state.left !== 0 || state.right !== state.vw) {
        throw new Error(`step ${i + 1}: sheet not full width (left ${state.left} right ${state.right} vw ${state.vw})`);
      }
      if (state.height > Math.round(state.vh * 0.45) + 2) {
        throw new Error(`step ${i + 1}: sheet taller than 45dvh (${state.height} > ${Math.round(state.vh * 0.45)})`);
      }
      if (state.bottom !== state.navTop) {
        throw new Error(`step ${i + 1}: sheet bottom ${state.bottom} != bottom nav top ${state.navTop}`);
      }
      if (!state.hasGrabber) throw new Error(`step ${i + 1}: grabber handle missing`);
      if (!state.hasLightDim) throw new Error(`step ${i + 1}: light dim missing`);
      if (state.hasRing) throw new Error(`step ${i + 1}: highlight ring still rendered`);
      if (state.titleBottom === null || state.titleBottom >= state.top) {
        throw new Error(`step ${i + 1}: screen title not visible above the sheet (title bottom ${state.titleBottom}, sheet top ${state.top})`);
      }
      if (state.skipH === null || state.skipH < 44) throw new Error(`step ${i + 1}: Skip button ${state.skipH}px tall`);
      if (state.nextH === null || state.nextH < 44 || state.nextBottom > state.navTop) {
        throw new Error(`step ${i + 1}: Next/Finish button not reachable (height ${state.nextH}, bottom ${state.nextBottom}, navTop ${state.navTop})`);
      }
      if (i === 0) await page.screenshot({ path: `${process.env.HOME}/workspace/olaseena-check-shots/mobile-tour-sheet-step-1.png` });
      if (i === 4) await page.screenshot({ path: `${process.env.HOME}/workspace/olaseena-check-shots/mobile-tour-sheet-step-5.png` });
      if (i < 11) {
        await page.getByRole("button", { name: "Next", exact: true }).click();
        await page.waitForTimeout(600);
      }
    }
    await page.getByRole("button", { name: "Finish", exact: true }).click();
    await page.getByText("Get to know Olaseena").waitFor({ state: "detached", timeout: 5000 });
  });

  await check("mobile tour: backdrop tap ends the tour", async () => {
    await page.getByRole("button", { name: "More", exact: true }).click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Get to know the features" }).click();
    await page.getByText("Get to know Olaseena").waitFor({ timeout: 5000 });
    await page.waitForTimeout(500);
    // Tap the dimmed screen above the sheet: the backdrop ends the tour.
    await page.mouse.click(195, 100);
    await page.getByText("Get to know Olaseena").waitFor({ state: "detached", timeout: 5000 });
  });

  await context.close();
}

/** Feature 4: the sheet buttons stay reachable on a shorter phone (360x740). */
async function mobileTourShortPhone(browser) {
  const context = await browser.newContext({
    viewport: { width: 360, height: 740 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  currentPage = page;
  await check("mobile tour: sheet buttons stay reachable at 360x740", async () => {
    await page.goto(`${BASE}/en`, { waitUntil: "networkidle" });
    await page.getByText("Get to know Olaseena").waitFor({ timeout: 8000 });
    await page.waitForTimeout(500);
    for (let i = 0; i < 12; i++) {
      const state = await page.evaluate(() => {
        const dlg = document.querySelector('[role="dialog"]');
        // Scroll the sheet to its end first: on a short phone the longest
        // step text can push the buttons below the 45dvh fold until scrolled.
        if (dlg) dlg.scrollTop = dlg.scrollHeight;
        const dr = dlg?.getBoundingClientRect();
        const nav = document.querySelector("nav.fixed");
        const nr = nav?.getBoundingClientRect();
        const btns = [...document.querySelectorAll('[role="dialog"] button')].map((b) => {
          const r = b.getBoundingClientRect();
          return { label: b.textContent.trim(), h: Math.round(r.height), bottom: Math.round(r.bottom), top: Math.round(r.top) };
        });
        return { sheetBottom: dr ? Math.round(dr.bottom) : null, navTop: nr ? Math.round(nr.top) : null, btns };
      });
      if (state.sheetBottom !== state.navTop) {
        throw new Error(`step ${i + 1}: sheet bottom ${state.sheetBottom} != nav top ${state.navTop}`);
      }
      for (const b of state.btns) {
        if (b.bottom > state.navTop || b.top < 0) {
          throw new Error(`step ${i + 1}: ${b.label} button outside the reachable area (top ${b.top} bottom ${b.bottom} navTop ${state.navTop})`);
        }
        if (b.h < 44) throw new Error(`step ${i + 1}: ${b.label} button ${b.h}px tall`);
      }
      if (i === 0) await page.screenshot({ path: `${process.env.HOME}/workspace/olaseena-check-shots/mobile-tour-sheet-360x740-step-1.png` });
      if (i < 11) {
        await page.getByRole("button", { name: "Next", exact: true }).click();
        await page.waitForTimeout(600);
      }
    }
    await page.getByRole("button", { name: "Finish", exact: true }).click();
    await page.getByText("Get to know Olaseena").waitFor({ state: "detached", timeout: 5000 });
  });
  await context.close();
}

/** Feature 4: every screen with seeded data on a phone, after the mobile polish. */
async function mobileScreensWithData(browser) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    acceptDownloads: true,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  currentPage = page;
  const consoleErrors = [];
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(`console: ${m.text()}`);
  });

  async function moreNav(name) {
    await page.getByRole("button", { name: "More", exact: true }).click();
    await page.getByRole("button", { name, exact: true }).click();
  }

  /** Lets stacked toasts clear so screenshots show the screen, not the toasts. */
  async function toastsGone() {
    await page.locator('[role="status"]').first().waitFor({ state: "detached", timeout: 10000 }).catch(() => {});
  }

  await check("mobile data: seed member, trainer, course, session, invoice, pay run", async () => {
    await page.goto(`${BASE}/en`, { waitUntil: "networkidle" });
    await trackAlerts(page);
    await page.getByText("Get to know Olaseena").waitFor({ timeout: 8000 });
    await page.getByRole("button", { name: "Skip tour" }).click();
    await nav(page, "Members");
    await page.getByRole("button", { name: "Add member" }).click();
    await page.getByLabel("Name", { exact: true }).fill("Ayu Lestari");
    await page.getByLabel("Email", { exact: true }).fill("ayu@example.com");
    await page.getByLabel("Phone", { exact: true }).fill("081234567890");
    await page.getByRole("button", { name: "Save changes" }).click();
    await toast(page, "Saved");
    await moreNav("Trainers");
    await page.getByRole("button", { name: "Add trainer" }).click();
    await page.getByLabel("Name", { exact: true }).fill("Budi Santoso");
    await page.getByLabel("Email", { exact: true }).fill("budi@example.com");
    await page.getByLabel("Subjects", { exact: true }).fill("Piano");
    await page.keyboard.press("Enter");
    await page.getByLabel("Rate per session (IDR)", { exact: true }).fill("150000");
    await page.getByRole("button", { name: "Save changes" }).click();
    await toast(page, "Saved");
    await nav(page, "Courses");
    await page.getByRole("button", { name: "Add course" }).click();
    await page.getByLabel("Title", { exact: true }).fill("Piano Basics");
    await page.getByLabel("Level", { exact: true }).fill("Beginner");
    await page.getByLabel("Price (IDR)", { exact: true }).fill("500000");
    await addRequiredSkill(page, "Piano");
    await page.getByRole("checkbox", { name: "Mon" }).check();
    await page.getByRole("checkbox", { name: "Wed" }).check();
    await page.getByRole("button", { name: "Save changes" }).click();
    await toast(page, "Saved");
    await page.locator("tr", { hasText: "Piano Basics" }).click();
    await page.getByText("Enrollments").first().waitFor();
    await page.getByText("Mon, Wed").waitFor();
    await page.getByRole("button", { name: "Enroll member" }).click();
    await pickSelect(page, "Member", "Ayu Lestari");
    await page.getByRole("button", { name: "Add", exact: true }).last().click();
    await toast(page, "Saved");
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
    await moreNav("Attendance");
    await pickSessionCourse(page, "Piano Basics");
    await page.getByRole("button", { name: "New session" }).click();
    await page.getByLabel("Topic", { exact: true }).fill("Scales");
    await pickTime(page, "Start time", "10:00");
    await pickTime(page, "End time", "11:30");
    await page.getByRole("radio", { name: "Budi Santoso" }).click();
    await page.getByRole("button", { name: "Add", exact: true }).last().click();
    await toast(page, "Saved");
    await page.locator("p", { hasText: "Scales" }).waitFor();
    await page.getByText("10:00–11:30 (1.5 h)").first().waitFor();
    await page.getByRole("radiogroup", { name: "Ayu Lestari" }).getByRole("radio", { name: "Present" }).click();
    await page.getByRole("switch", { name: "Trainer present" }).click();
    await page.getByRole("button", { name: "Mark attendance" }).click();
    await toast(page, "Attendance saved");
    await nav(page, "Invoices");
    await page.getByRole("button", { name: "New invoice" }).click();
    await pickSelect(page, "Member", "Ayu Lestari");
    await pickSelect(page, "Status", "Sent");
    await page.getByLabel("Description", { exact: true }).fill("Piano Basics Nov");
    await page.getByLabel("Amount", { exact: true }).fill("500000");
    await page.getByRole("button", { name: "Create invoice" }).click();
    await toast(page, "Saved");
    await page.locator("tr", { hasText: "Ayu Lestari" }).first().click();
    await page.getByRole("button", { name: "Record payment", exact: true }).waitFor();
    await page.getByLabel("Payment amount", { exact: true }).fill("200000");
    await page.getByRole("button", { name: "Record payment", exact: true }).click();
    await toast(page, "Payment recorded");
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
    await moreNav("Payroll");
    await pickSelect(page, "Trainer", "Budi Santoso");
    await page.getByRole("button", { name: "Generate pay run" }).click();
    await toast(page, "Saved");
    await toastsGone();
  });

  await check("mobile data: dashboard with data, no overflow, footer clear", async () => {
    await nav(page, "Dashboard");
    await page.getByText("IDR 200,000").first().waitFor();
    await page.getByText("100%").waitFor();
    await noOverflow(page, "mobile data dashboard", 390);
    await footerClearOfNav(page);
    await toastsGone();
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: `${process.env.HOME}/workspace/olaseena-check-shots/mobile-data-dashboard-390.png` });
  });

  await check("mobile data: members table, row actions are 44px", async () => {
    await nav(page, "Members");
    await page.getByText("Ayu Lestari").waitFor();
    await noOverflow(page, "mobile data members", 390);
    await fixedTargetsAtLeast44(page, "members");
    await footerClearOfNav(page);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: `${process.env.HOME}/workspace/olaseena-check-shots/mobile-data-members-390.png` });
  });

  await check("mobile data: trainers table, row actions are 44px", async () => {
    await moreNav("Trainers");
    await page.getByText("Budi Santoso").waitFor();
    await noOverflow(page, "mobile data trainers", 390);
    await fixedTargetsAtLeast44(page, "trainers");
    await footerClearOfNav(page);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: `${process.env.HOME}/workspace/olaseena-check-shots/mobile-data-trainers-390.png` });
  });

  await check("mobile data: session attendee assignment at 390px", async () => {
    const pending = page.locator("section").filter({ has: page.getByRole("heading", { name: "Sessions" }) });
    try {
      // A fresh unmarked session on a course day (Piano Basics meets
      // Mondays and Wednesdays): Scales was already marked during the seed.
      const nextCourseDay = upcomingSlotDates(3).find((d) => d.getDay() === 1 || d.getDay() === 3);
      await createSession(page, "Arpeggios", nextCourseDay, true);
      await nav(page, "Courses");
      await pending.getByText("Arpeggios").waitFor();
      await pending.getByText("Piano Basics").waitFor();
      await pending.getByText("All enrolled members").waitFor();
      await pending.getByRole("button", { name: "Assign members" }).click();
      await pending.getByRole("checkbox", { name: "Ayu Lestari" }).check();
      await pending.getByRole("button", { name: "Save changes" }).click();
      await toast(page, "Saved");
      await pending.getByText("Assigned: Ayu Lestari").waitFor();
      await noOverflow(page, "mobile data assign", 390);
      await fixedTargetsAtLeast44(page, "assign picker");
      // Uncheck again: the session goes back to all enrolled members.
      await pending.getByRole("button", { name: "Assign members" }).click();
      await pending.getByRole("checkbox", { name: "Ayu Lestari" }).uncheck();
      await pending.getByRole("button", { name: "Save changes" }).click();
      await toast(page, "Saved");
      await pending.getByText("All enrolled members").waitFor();
      // Clean up: delete the check session so later mobile checks see only
      // the sessions they create themselves.
      const detailDialog = page.locator('[role="dialog"]', { hasText: "Piano Basics" });
      await page.locator("tr", { hasText: "Piano Basics" }).click();
      await page.getByText("Enrollments").first().waitFor();
      const row = detailDialog.locator("li", { hasText: "Arpeggios" });
      await row.getByRole("button", { name: "Delete session" }).click();
      await page.getByRole("button", { name: "Delete", exact: true }).click();
      // The confirm is an AlertDialog layered above the detail dialog: wait
      // for it to leave before touching the detail dialog's own close, or
      // the click lands while the detail is still hidden behind it.
      await page.locator('[role="alertdialog"]').waitFor({ state: "detached", timeout: 5000 });
      await row.waitFor({ state: "detached", timeout: 8000 });
      await detailDialog.getByRole("button", { name: "Close" }).click();
      await detailDialog.waitFor({ state: "detached", timeout: 5000 });
    } finally {
      const close = page.getByRole("button", { name: "Close" });
      if (await close.count()) await close.first().click().catch(() => {});
    }
  });

  await check("mobile data: course detail modal, no overflow", async () => {
    await nav(page, "Courses");
    await page.locator("tr", { hasText: "Piano Basics" }).click();
    await page.getByText("Enrollments").first().waitFor();
    await page.getByText("Ayu Lestari").waitFor();
    await noOverflow(page, "mobile data course detail", 390);
    await fixedTargetsAtLeast44(page, "course detail");
    await page.screenshot({ path: `${process.env.HOME}/workspace/olaseena-check-shots/mobile-data-course-detail-390.png` });
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
  });

  await check("mobile data: attendance with a session, radio targets are 44px", async () => {
    await moreNav("Attendance");
    await pickSessionCourse(page, "Piano Basics");
    // The session option is labeled with its date and topic, so match the topic part.
    await page.getByRole("combobox", { name: "Sessions", exact: true }).click();
    await page.getByRole("option", { name: /Scales/ }).click();
    await page.getByRole("radiogroup", { name: "Ayu Lestari" }).waitFor();
    await noOverflow(page, "mobile data attendance", 390);
    const radioH = await page.evaluate(() => {
      const radios = [...document.querySelectorAll('[role="radio"]')];
      return radios.length ? Math.min(...radios.map((r) => Math.round(r.getBoundingClientRect().height))) : null;
    });
    if (radioH === null || radioH < 44) throw new Error(`attendance radio buttons ${radioH}px tall`);
    await fixedTargetsAtLeast44(page, "attendance");
    await footerClearOfNav(page);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: `${process.env.HOME}/workspace/olaseena-check-shots/mobile-data-attendance-390.png` });
  });

  await check("mobile data: invoice detail modal, no overflow", async () => {
    await nav(page, "Invoices");
    await page.locator("tr", { hasText: "Ayu Lestari" }).first().click();
    await page.getByRole("button", { name: "Record payment", exact: true }).waitFor();
    await page.getByText("Partially paid").first().waitFor();
    await noOverflow(page, "mobile data invoice detail", 390);
    await fixedTargetsAtLeast44(page, "invoice detail");
    await page.screenshot({ path: `${process.env.HOME}/workspace/olaseena-check-shots/mobile-data-invoice-detail-390.png` });
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
  });

  await check("mobile data: payroll review, no overflow", async () => {
    await moreNav("Payroll");
    await page.locator("tr", { hasText: "Budi Santoso" }).click();
    await page.getByText("Review pay run").waitFor();
    await page.getByText("IDR 150,000").first().waitFor();
    await noOverflow(page, "mobile data payroll review", 390);
    await fixedTargetsAtLeast44(page, "payroll review");
    await page.screenshot({ path: `${process.env.HOME}/workspace/olaseena-check-shots/mobile-data-payroll-390.png` });
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
  });

  await check("mobile data: Drive section renders gated while signed out, toggle off", async () => {
    await moreNav("Settings");
    await page.getByRole("heading", { name: "Google Drive" }).waitFor();
    await page.getByText("Not connected").waitFor();
    const backupBtn = page.getByRole("button", { name: "Back up to Drive" });
    const restoreBtn = page.getByRole("button", { name: "Restore from Drive" });
    if (!(await backupBtn.isDisabled())) throw new Error("Back up to Drive is enabled while signed out");
    if (!(await restoreBtn.isDisabled())) throw new Error("Restore from Drive is enabled while signed out");
    const syncToggle = page.getByRole("switch", { name: /Auto-sync to Drive/ });
    if ((await syncToggle.getAttribute("aria-checked")) !== "false") throw new Error("auto-sync is on by default");
    if (!(await syncToggle.isDisabled())) throw new Error("auto-sync toggle is enabled while signed out");
    await noOverflow(page, "mobile drive section", 390);
  });

  await check("mobile data: settings, footer clears the bottom nav", async () => {
    await moreNav("Settings");
    await noOverflow(page, "mobile data settings", 390);
    await footerClearOfNav(page);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: `${process.env.HOME}/workspace/olaseena-check-shots/mobile-data-settings-390.png` });
  });

  await check("mobile data: no console errors or page errors", async () => {
    if (consoleErrors.length) throw new Error(consoleErrors.slice(0, 3).join(" | "));
    const alerts = await page.evaluate(() => window.__alerts ?? []);
    if (alerts.length) throw new Error(`error toasts shown: ${alerts.slice(0, 3).join(" | ")}`);
  });

  await context.close();
  return consoleErrors;
}

/** Feature 4: dark theme on a phone, switched from Settings. */
async function mobileDarkMode(browser) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  currentPage = page;
  await check("mobile dark: switch to dark in Settings, dashboard stays readable", async () => {
    await page.goto(`${BASE}/en`, { waitUntil: "networkidle" });
    await page.getByText("Get to know Olaseena").waitFor({ timeout: 8000 });
    await page.getByRole("button", { name: "Skip tour" }).click();
    await page.getByRole("button", { name: "More", exact: true }).click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("radio", { name: "Dark" }).click();
    await page.waitForFunction(() => document.documentElement.classList.contains("dark"), null, { timeout: 5000 });
    await nav(page, "Dashboard");
    await noOverflow(page, "mobile dark dashboard", 390);
    await page.screenshot({ path: `${process.env.HOME}/workspace/olaseena-check-shots/mobile-data-dark-dashboard-390.png` });
  });
  await context.close();
}

/** v0.2.0 print: transfer invoice shows the payment block and both downloads are non-empty files; a cash invoice shows no payment block. */
async function printChecks(browser) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    acceptDownloads: true,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  currentPage = page;
  const consoleErrors = [];
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(`console: ${m.text()}`);
  });

  async function createInvoice(paymentMethod, details, amount = 500000) {
    await nav(page, "Invoices");
    await page.getByRole("button", { name: "New invoice" }).click();
    await pickSelect(page, "Member", "Ayu Lestari");
    await pickSelect(page, "Status", "Sent");
    if (paymentMethod) await pickSelect(page, "Payment method", paymentMethod);
    if (details) await page.getByLabel("Payment details", { exact: true }).fill(details);
    await page.getByLabel("Description", { exact: true }).fill("Piano Basics Nov");
    await page.getByLabel("Amount", { exact: true }).fill(String(amount));
    await page.getByRole("button", { name: "Create invoice" }).click();
    await toast(page, "Saved");
  }

  function previewDialog() {
    return page.locator('[role="dialog"]:has-text("Invoice preview")').last();
  }

  await check("print: seed member for invoices", async () => {
    await page.goto(`${BASE}/en`, { waitUntil: "networkidle" });
    await trackAlerts(page);
    await page.getByText("Get to know Olaseena").waitFor({ timeout: 8000 });
    await page.getByRole("button", { name: "Skip tour" }).click();
    await page.getByText("Get to know Olaseena").waitFor({ state: "detached", timeout: 5000 });
    await nav(page, "Members");
    await page.getByRole("button", { name: "Add member" }).click();
    await page.getByLabel("Name", { exact: true }).fill("Ayu Lestari");
    await page.getByLabel("Email", { exact: true }).fill("ayu@example.com");
    await page.getByRole("button", { name: "Save changes" }).click();
    await toast(page, "Saved");
  });

  await check("print: transfer invoice preview shows payment details and PNG downloads", async () => {
    try {
      await createInvoice("Bank transfer", "BCA 1234567890 a.n. Olaseena");
      await page.locator("tr", { hasText: "Ayu Lestari" }).first().click();
      await page.getByRole("button", { name: "Print invoice", exact: true }).waitFor();
      await page.getByRole("button", { name: "Print invoice", exact: true }).click();
      await previewDialog().getByText("BCA 1234567890 a.n. Olaseena").waitFor({ timeout: 8000 });
      await page.screenshot({ path: `${process.env.HOME}/workspace/olaseena-check-shots/v020-print-preview.png` });
      const downloadPromise = page.waitForEvent("download", { timeout: 30000 });
      await previewDialog().getByRole("button", { name: "Download PNG", exact: true }).click();
      const download = await downloadPromise;
      const path = await download.path();
      if (!path) throw new Error("PNG download has no path");
      const size = statSync(path).size;
      if (size < 1000) throw new Error(`PNG too small: ${size} bytes`);
      if (!download.suggestedFilename().endsWith(".png")) {
        throw new Error(`unexpected PNG name: ${download.suggestedFilename()}`);
      }
    } finally {
      const close = page.getByRole("button", { name: "Close" });
      if (await close.count()) await close.first().click().catch(() => {});
    }
  });

  await check("print: same transfer invoice downloads a valid PDF", async () => {
    try {
      await nav(page, "Invoices");
      await page.locator("tr", { hasText: "Ayu Lestari" }).first().click();
      await page.getByRole("button", { name: "Print invoice", exact: true }).click();
      await previewDialog().getByText("BCA 1234567890 a.n. Olaseena").waitFor({ timeout: 8000 });
      const downloadPromise = page.waitForEvent("download", { timeout: 30000 });
      await previewDialog().getByRole("button", { name: "Download PDF", exact: true }).click();
      const download = await downloadPromise;
      const path = await download.path();
      if (!path) throw new Error("PDF download has no path");
      const size = statSync(path).size;
      if (size < 1000) throw new Error(`PDF too small: ${size} bytes`);
      if (!download.suggestedFilename().endsWith(".pdf")) {
        throw new Error(`unexpected PDF name: ${download.suggestedFilename()}`);
      }
      if (readFileSync(path).subarray(0, 5).toString() !== "%PDF-") {
        throw new Error("downloaded file is not a PDF");
      }
    } finally {
      const close = page.getByRole("button", { name: "Close" });
      if (await close.count()) await close.first().click().catch(() => {});
    }
  });

  await check("print: cash invoice preview shows no payment block", async () => {
    try {
      // Distinct amount so its row is unambiguous regardless of list order.
      await createInvoice(null, null, 250000);
      await page.locator("tr", { hasText: "IDR 250,000" }).first().click();
      await page.getByRole("button", { name: "Print invoice", exact: true }).click();
      const dialog = previewDialog();
      await dialog.getByText("Invoice preview").waitFor({ timeout: 8000 });
      if (await dialog.getByText("Payment details", { exact: true }).count()) {
        throw new Error("cash invoice preview shows a payment details block");
      }
      if (await dialog.getByText("BCA 1234567890").count()) {
        throw new Error("cash invoice preview leaks the transfer details");
      }
    } finally {
      const close = page.getByRole("button", { name: "Close" });
      if (await close.count()) await close.first().click().catch(() => {});
    }
  });

  await check("print: no console errors or page errors", async () => {
    if (consoleErrors.length) throw new Error(consoleErrors.slice(0, 3).join(" | "));
    const alerts = await page.evaluate(() => window.__alerts ?? []);
    if (alerts.length) throw new Error(`error toasts shown: ${alerts.slice(0, 3).join(" | ")}`);
  });

  await context.close();
}

/** v0.2.0 dark theme on desktop: switch in Settings, dashboard + invoice form render without overflow, then back to light. */
async function darkDesktop(browser) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  currentPage = page;
  const consoleErrors = [];
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(`console: ${m.text()}`);
  });

  await check("dark desktop: switch to dark in Settings", async () => {
    await page.goto(`${BASE}/en`, { waitUntil: "networkidle" });
    await trackAlerts(page);
    await page.getByText("Get to know Olaseena").waitFor({ timeout: 8000 });
    await page.getByRole("button", { name: "Skip tour" }).click();
    await page.getByText("Get to know Olaseena").waitFor({ state: "detached", timeout: 5000 });
    await nav(page, "Settings");
    await page.getByRole("radio", { name: "Dark", exact: true }).click();
    const isDark = await page.evaluate(() => document.documentElement.classList.contains("dark"));
    if (!isDark) throw new Error("html.dark class not applied after choosing Dark");
    await page.waitForTimeout(300);
  });

  await check("dark desktop: dashboard renders without overflow", async () => {
    await nav(page, "Dashboard");
    await noOverflow(page, "dark dashboard", 1280);
    await page.screenshot({ path: `${process.env.HOME}/workspace/olaseena-check-shots/v020-dark-dashboard.png` });
  });

  await check("dark desktop: invoice form renders without overflow", async () => {
    await nav(page, "Invoices");
    await page.getByRole("button", { name: "New invoice" }).click();
    await noOverflow(page, "dark invoice form", 1280);
    await page.getByRole("button", { name: "Cancel", exact: true }).click().catch(() => {});
  });

  await check("dark desktop: back to light removes the class and survives reload", async () => {
    await nav(page, "Settings");
    await page.getByRole("radio", { name: "Light", exact: true }).click();
    const isDark = await page.evaluate(() => document.documentElement.classList.contains("dark"));
    if (isDark) throw new Error("html.dark class still present after choosing Light");
    await page.reload({ waitUntil: "networkidle" });
    const stillLight = await page.evaluate(() => !document.documentElement.classList.contains("dark"));
    if (!stillLight) throw new Error("theme did not persist as Light after reload");
  });

  await check("dark desktop: no console errors or page errors", async () => {
    if (consoleErrors.length) throw new Error(consoleErrors.slice(0, 3).join(" | "));
    const alerts = await page.evaluate(() => window.__alerts ?? []);
    if (alerts.length) throw new Error(`error toasts shown: ${alerts.slice(0, 3).join(" | ")}`);
  });

  await context.close();
}

/** v0.2.0 currency: stubbed Frankfurter rates drive the switch, the 10/day limit blocks the 11th, and a failed fetch changes nothing. */
/** v0.8.0 weekly slot: a session or enrollment outside the course's weekdays shows the error naming the allowed days; on a slot day both save. */
async function weeklySlotChecks(browser) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  currentPage = page;
  const consoleErrors = [];
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(`console: ${m.text()}`);
  });

  // The slot is chosen so today is outside it, whatever day the check runs:
  // weekends when today is a weekday, Monday and Tuesday when today is a weekend day.
  const todayDow = new Date().getDay();
  const offDays = todayDow === 6 || todayDow === 0 ? [1, 2] : [6, 0];
  const short = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const full = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const offNames = [...offDays].sort((a, b) => a - b).map((d) => full[d]).join(", ");
  const onDay = todayDow;

  async function seedMemberTrainer() {
    await page.goto(`${BASE}/en`, { waitUntil: "networkidle" });
    await trackAlerts(page);
    await page.getByText("Get to know Olaseena").waitFor({ timeout: 8000 });
    await page.getByRole("button", { name: "Skip tour" }).click();
    await page.getByText("Get to know Olaseena").waitFor({ state: "detached", timeout: 5000 });
    await nav(page, "Members");
    await page.getByRole("button", { name: "Add member" }).click();
    await page.getByLabel("Name", { exact: true }).fill("Ayu Lestari");
    await page.getByLabel("Email", { exact: true }).fill("ayu@example.com");
    await page.getByRole("button", { name: "Save changes" }).click();
    await toast(page, "Saved");
    await nav(page, "Trainers");
    await page.getByRole("button", { name: "Add trainer" }).click();
    await page.getByLabel("Name", { exact: true }).fill("Budi Santoso");
    await page.getByLabel("Email", { exact: true }).fill("budi@example.com");
    await page.getByLabel("Subjects", { exact: true }).fill("Piano");
    await page.keyboard.press("Enter");
    await page.getByLabel("Rate per session (IDR)", { exact: true }).fill("150000");
    await page.getByRole("button", { name: "Save changes" }).click();
    await toast(page, "Saved");
  }

  async function addCourse(title, days) {
    await nav(page, "Courses");
    await page.getByRole("button", { name: "Add course" }).click();
    await page.getByLabel("Title", { exact: true }).fill(title);
    await page.getByLabel("Level", { exact: true }).fill("Beginner");
    await page.getByLabel("Price (IDR)", { exact: true }).fill("500000");
    await addRequiredSkill(page, "Piano");
    // The form starts with Monday checked, so clear it first: the slot must be exactly the days asked for.
    await page.getByRole("checkbox", { name: "Mon" }).uncheck();
    for (const d of days) await page.getByRole("checkbox", { name: short[d] }).check();
    await page.getByRole("button", { name: "Save changes" }).click();
    await toast(page, "Saved");
  }

  await check("weekly slot: enrollment outside the slot shows the error naming the allowed days", async () => {
    await seedMemberTrainer();
    await addCourse("Weekend Piano", offDays);
    await page.locator("tr", { hasText: "Weekend Piano" }).click();
    await page.getByText("Enrollments").first().waitFor();
    await page.getByRole("button", { name: "Enroll member" }).click();
    await pickSelect(page, "Member", "Ayu Lestari");
    await page.getByRole("button", { name: "Add", exact: true }).last().click();
    await page.getByText(`Start date must be on a day this course meets: ${offNames}.`, { exact: true }).waitFor({ timeout: 5000 });
    if (await page.locator("ul li", { hasText: "Ayu Lestari" }).count()) throw new Error("off-slot enrollment was listed anyway");
  });

  await check("weekly slot: session outside the slot shows the error naming the allowed days", async () => {
    await page.getByRole("button", { name: "New session" }).click();
    await page.getByLabel("Topic", { exact: true }).fill("Off-slot scales");
    await page.getByRole("button", { name: "Add", exact: true }).last().click();
    await page.getByText(`Date must be on a day this course meets: ${offNames}.`, { exact: true }).waitFor({ timeout: 5000 });
    if (await page.locator("ul li", { hasText: "Off-slot scales" }).count()) throw new Error("off-slot session was listed anyway");
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
  });

  await check("weekly slot: enrollment and session on a slot day save", async () => {
    await addCourse("Today Piano", [onDay]);
    await page.locator("tr", { hasText: "Today Piano" }).click();
    await page.getByText("Enrollments").first().waitFor();
    await page.getByRole("button", { name: "Enroll member" }).click();
    await pickSelect(page, "Member", "Ayu Lestari");
    await page.getByRole("button", { name: "Add", exact: true }).last().click();
    await toast(page, "Saved");
    await page.getByRole("button", { name: "New session" }).click();
    await page.getByLabel("Topic", { exact: true }).fill("On-slot scales");
    await pickTime(page, "Start time", "10:00");
    await pickTime(page, "End time", "11:00");
    await page.getByRole("radio", { name: "Budi Santoso" }).click();
    await page.getByRole("button", { name: "Add", exact: true }).last().click();
    await toast(page, "Saved");
    // The session also appears in the Sessions section behind this dialog, so scope to the dialog.
    await page.locator('[role="dialog"]').getByText("On-slot scales").waitFor();
    await page.getByText("10:00–11:00").first().waitFor();
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
    await noOverflow(page, "weekly slot", 1280);
  });

  await check("weekly slot: no console errors or page errors", async () => {
    if (consoleErrors.length) throw new Error(consoleErrors.slice(0, 3).join(" | "));
    const alerts = await page.evaluate(() => window.__alerts ?? []);
    // The two slot errors above are the expected outcome of those checks, not stray toasts.
    const unexpected = alerts.filter((a) => !a.includes("must be on a day this course meets"));
    if (unexpected.length) throw new Error(`error toasts shown: ${unexpected.slice(0, 3).join(" | ")}`);
  });
  await context.close();
}

/** v0.8.0 time picker: opens, picks a time the form keeps, rejects end at or before start, and fits a 390px phone. */
async function timePickerChecks(browser) {
  const short = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const todayShort = short[new Date().getDay()];

  async function seed(page, onMobile = false) {
    // On a phone Trainers and Attendance live under the More menu, not the bottom nav.
    const go = async (name) => {
      if (onMobile && (name === "Trainers" || name === "Attendance")) {
        await page.getByRole("button", { name: "More", exact: true }).click();
        await page.getByRole("button", { name, exact: true }).click();
      } else {
        await nav(page, name);
      }
    };
    await page.goto(`${BASE}/en`, { waitUntil: "networkidle" });
    await trackAlerts(page);
    await page.getByText("Get to know Olaseena").waitFor({ timeout: 8000 });
    await page.getByRole("button", { name: "Skip tour" }).click();
    await page.getByText("Get to know Olaseena").waitFor({ state: "detached", timeout: 5000 });
    await go("Members");
    await page.getByRole("button", { name: "Add member" }).click();
    await page.getByLabel("Name", { exact: true }).fill("Ayu Lestari");
    await page.getByLabel("Email", { exact: true }).fill("ayu@example.com");
    await page.getByRole("button", { name: "Save changes" }).click();
    await toast(page, "Saved");
    await go("Trainers");
    await page.getByRole("button", { name: "Add trainer" }).click();
    await page.getByLabel("Name", { exact: true }).fill("Budi Santoso");
    await page.getByLabel("Email", { exact: true }).fill("budi@example.com");
    await page.getByLabel("Subjects", { exact: true }).fill("Piano");
    await page.keyboard.press("Enter");
    await page.getByLabel("Rate per session (IDR)", { exact: true }).fill("150000");
    await page.getByRole("button", { name: "Save changes" }).click();
    await toast(page, "Saved");
    await go("Courses");
    await page.getByRole("button", { name: "Add course" }).click();
    await page.getByLabel("Title", { exact: true }).fill("Piano Basics");
    await page.getByLabel("Level", { exact: true }).fill("Beginner");
    await page.getByLabel("Price (IDR)", { exact: true }).fill("500000");
    await addRequiredSkill(page, "Piano");
    await page.getByRole("checkbox", { name: todayShort }).check();
    await page.getByRole("button", { name: "Save changes" }).click();
    await toast(page, "Saved");
  }

  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  currentPage = page;
  const consoleErrors = [];
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(`console: ${m.text()}`);
  });

  await check("time picker: opens, picks a time, and the form keeps the value", async () => {
    await seed(page);
    await nav(page, "Attendance");
    await pickSessionCourse(page, "Piano Basics");
    await page.getByRole("button", { name: "New session" }).click();
    await page.getByLabel("Topic", { exact: true }).fill("Picker scales");
    await pickTime(page, "Start time", "10:00");
    await pickTime(page, "End time", "11:30");
    await expectTrigger(page, "Start time", "10:00");
    await expectTrigger(page, "End time", "11:30");
    await page.getByRole("radio", { name: "Budi Santoso" }).click();
    await page.getByRole("button", { name: "Add", exact: true }).last().click();
    await toast(page, "Saved");
    await page.getByText("10:00–11:30 (1.5 h)").first().waitFor();
  });

  await check("time picker: end at or before start still shows the error", async () => {
    await page.getByRole("button", { name: "New session" }).click();
    await page.getByLabel("Topic", { exact: true }).fill("Bad range");
    await pickTime(page, "Start time", "11:00");
    await pickTime(page, "End time", "10:00");
    await page.getByRole("button", { name: "Add", exact: true }).last().click();
    await page.getByText("End time must be after the start time.").waitFor({ timeout: 5000 });
    if (await page.locator("p", { hasText: "Bad range" }).count()) throw new Error("invalid time range was listed anyway");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
  });

  await check("time picker: no console errors or page errors", async () => {
    if (consoleErrors.length) throw new Error(consoleErrors.slice(0, 3).join(" | "));
    const alerts = await page.evaluate(() => window.__alerts ?? []);
    // The end-before-start error above is the expected outcome of that check, not a stray toast.
    const unexpected = alerts.filter((a) => !a.includes("End time must be after the start time"));
    if (unexpected.length) throw new Error(`error toasts shown: ${unexpected.slice(0, 3).join(" | ")}`);
  });
  await context.close();

  const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const mobilePage = await mobileContext.newPage();
  mobilePage.setDefaultTimeout(10000);
  currentPage = mobilePage;
  const mobileErrors = [];
  mobilePage.on("pageerror", (e) => mobileErrors.push(`pageerror: ${e.message}`));
  mobilePage.on("console", (m) => {
    if (m.type() === "error") mobileErrors.push(`console: ${m.text()}`);
  });

  await check("time picker mobile: opens at 390px without overflow and picks a time", async () => {
    await seed(mobilePage, true);
    await mobilePage.getByRole("button", { name: "More", exact: true }).click();
    await mobilePage.getByRole("button", { name: "Attendance", exact: true }).click();
    await pickSessionCourse(mobilePage, "Piano Basics");
    await mobilePage.getByRole("button", { name: "New session" }).click();
    await mobilePage.getByLabel("Topic", { exact: true }).fill("Mobile scales");
    await mobilePage.getByRole("button", { name: "Start time", exact: true }).click();
    await mobilePage.getByRole("group", { name: "Hour" }).waitFor();
    await noOverflow(mobilePage, "time picker open", 390);
    await mobilePage.getByRole("group", { name: "Hour" }).getByRole("button", { name: "09", exact: true }).click();
    await mobilePage.getByRole("group", { name: "Minute" }).getByRole("button", { name: "30", exact: true }).click();
    await expectTrigger(mobilePage, "Start time", "09:30");
    await noOverflow(mobilePage, "time picker picked", 390);
    await mobilePage.getByRole("button", { name: "Cancel", exact: true }).click();
  });

  await check("time picker mobile: no console errors or page errors", async () => {
    if (mobileErrors.length) throw new Error(mobileErrors.slice(0, 3).join(" | "));
    const alerts = await mobilePage.evaluate(() => window.__alerts ?? []);
    if (alerts.length) throw new Error(`error toasts shown: ${alerts.slice(0, 3).join(" | ")}`);
  });
  await mobileContext.close();
}

/** Reads a TimePicker trigger's shown value; the accessible name is the field label, the value is its text. */
function expectTrigger(page, label, value) {
  return page.evaluate(
    ([label, value]) => {
      const trigger = [...document.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === label);
      if (!trigger) throw new Error(`no time picker trigger for ${label}`);
      if (!trigger.textContent.includes(value)) throw new Error(`${label} shows ${trigger.textContent.trim()}, expected ${value}`);
    },
    [label, value],
  );
}

async function currencyChecks(browser) {
  const RATES = {
    "IDR->EUR": 0.00005,
    "EUR->IDR": 20000,
    "EUR->USD": 1.08,
    "USD->EUR": 0.92,
    "IDR->USD": 0.00006,
    "USD->IDR": 16666.67,
  };
  async function stubRates(page) {
    await page.route("**/api.frankfurter.dev/**", (route) => {
      const url = new URL(route.request().url());
      const base = url.searchParams.get("base");
      const symbols = (url.searchParams.get("symbols") ?? "").split(",").filter(Boolean);
      const rates = {};
      for (const sym of symbols) rates[sym] = RATES[`${base}->${sym}`];
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ amount: 1.0, base, date: "2026-11-19", rates }),
      });
    });
  }

  async function seedInvoice(page, amount) {
    await page.goto(`${BASE}/en`, { waitUntil: "networkidle" });
    await trackAlerts(page);
    await page.getByText("Get to know Olaseena").waitFor({ timeout: 8000 });
    await page.getByRole("button", { name: "Skip tour" }).click();
    await page.getByText("Get to know Olaseena").waitFor({ state: "detached", timeout: 5000 });
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
    await page.getByLabel("Amount", { exact: true }).fill(String(amount));
    await page.getByRole("button", { name: "Create invoice" }).click();
    await toast(page, "Saved");
  }

  async function switchTo(page, code) {
    await nav(page, "Settings");
    await page.getByRole("button", { name: code, exact: true }).click();
    await page.getByRole("button", { name: "Switch and convert", exact: true }).click();
    await toast(page, `Currency switched to ${code}`);
  }

  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  currentPage = page;
  const consoleErrors = [];
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(`console: ${m.text()}`);
  });
  await stubRates(page);

  await check("currency: switch IDR to EUR converts the invoice total", async () => {
    await seedInvoice(page, 1000000);
    await nav(page, "Settings");
    await page.getByRole("button", { name: "EUR", exact: true }).click();
    await page.getByText("You have 10 of 10 switches left today").waitFor({ timeout: 5000 });
    await page.getByRole("button", { name: "Switch and convert", exact: true }).click();
    await toast(page, "Currency switched to EUR");
    await nav(page, "Invoices");
    await page.getByText("€50.00").first().waitFor({ timeout: 5000 });
  });

  await check("currency: trainer rate label follows the switch to EUR", async () => {
    await nav(page, "Trainers");
    await page.getByRole("button", { name: "Add trainer" }).click();
    await page.getByLabel("Rate per session (EUR)", { exact: true }).waitFor({ timeout: 5000 });
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
  });

  await check("currency: 10 switches allowed, 11th shows the limit and changes nothing", async () => {
    // Switch 1 (IDR to EUR) is done; 9 more alternating switches reach 10.
    const sequence = ["USD", "EUR", "USD", "EUR", "USD", "EUR", "USD", "EUR", "USD"];
    for (const code of sequence) await switchTo(page, code);
    await nav(page, "Settings");
    await page.getByRole("button", { name: "EUR", exact: true }).click();
    await page.getByText("Daily limit reached. You have used all 10 currency switches for today. Try again tomorrow.").waitFor({ timeout: 5000 });
    if (await page.getByRole("button", { name: "Switch and convert", exact: true }).count()) {
      throw new Error("limit dialog still offers a Switch button");
    }
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
    // Currency is still USD after 10 switches (last one was to USD).
    await nav(page, "Invoices");
    await page.getByText("$").first().waitFor({ timeout: 5000 });
  });

  await check("currency: no console errors or page errors", async () => {
    if (consoleErrors.length) throw new Error(consoleErrors.slice(0, 3).join(" | "));
    const alerts = await page.evaluate(() => window.__alerts ?? []);
    if (alerts.length) throw new Error(`error toasts shown: ${alerts.slice(0, 3).join(" | ")}`);
  });
  await context.close();

  const failContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const failPage = await failContext.newPage();
  failPage.setDefaultTimeout(10000);
  currentPage = failPage;
  const failErrors = [];
  failPage.on("pageerror", (e) => failErrors.push(`pageerror: ${e.message}`));
  failPage.on("console", (m) => {
    if (m.type() === "error") failErrors.push(`console: ${m.text()}`);
  });
  await failPage.route("**/api.frankfurter.dev/**", (route) => route.abort());
  await failPage.route("**/api.exchangerate-api.com/**", (route) => route.abort());

  await check("currency: failed rate fetch shows an error toast and leaves IDR untouched", async () => {
    await seedInvoice(failPage, 1000000);
    await nav(failPage, "Settings");
    await failPage.getByRole("button", { name: "EUR", exact: true }).click();
    await failPage.getByRole("button", { name: "Switch and convert", exact: true }).click();
    await toast(failPage, "Rate unavailable", "alert");
    await nav(failPage, "Invoices");
    await failPage.getByText("IDR 1,000,000").first().waitFor({ timeout: 5000 });
  });

  await check("currency failure: no console errors or page errors", async () => {
    // The aborted rate fetch logs a resource error and errorCenter logs the
    // reported error by design; both are the expected failure path, not bugs.
    const expected = (e) => e.includes("ERR_FAILED") || e.includes("CURRENCY_FETCH_FAILED");
    const unexpected = failErrors.filter((e) => !expected(e));
    if (unexpected.length) throw new Error(unexpected.slice(0, 3).join(" | "));
    const alerts = await failPage.evaluate(() => window.__alerts ?? []);
    const other = alerts.filter((a) => !a.includes("Rate unavailable"));
    if (other.length) throw new Error(`unexpected error toasts: ${other.slice(0, 3).join(" | ")}`);
  });
  await failContext.close();
}

/** Regression for the tour overflowing a short viewport: at 1280x600 the tooltip must stay fully on screen on every step, with Skip and Next clickable. */
async function shortViewportTour(browser) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 600 } });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  currentPage = page;
  await check("short viewport: tour tooltip stays inside the viewport on all 12 steps", async () => {
    await page.goto(`${BASE}/en`, { waitUntil: "networkidle" });
    await page.getByText("Get to know Olaseena").waitFor({ timeout: 8000 });
    await page.waitForTimeout(500);
    // The steps in tour order: the overlay falls back to a centered tooltip
    // when its target is missing, so check each target is really on screen.
    const targets = ["dashboard", "members", "trainers", "courses", "course-sessions", "attendance", "invoices", "payroll", "trash", "settings", "drive", "profile"];
    for (let i = 0; i < 12; i++) {
      const hasTarget = await page.evaluate((t) => !!document.querySelector(`[data-tour="${t}"]`), targets[i]);
      if (!hasTarget) throw new Error(`step ${i + 1}: no [data-tour="${targets[i]}"] target on screen`);
      const box = await page.evaluate(() => {
        const dlg = document.querySelector('[role="dialog"]');
        const r = dlg?.getBoundingClientRect();
        const skip = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Skip tour");
        const s = skip?.getBoundingClientRect();
        return {
          top: r ? Math.round(r.top) : null,
          bottom: r ? Math.round(r.bottom) : null,
          vh: window.innerHeight,
          skipVisible: s ? s.bottom <= window.innerHeight && s.top >= 0 : false,
        };
      });
      if (box.top === null || box.top < 0 || box.bottom > box.vh || !box.skipVisible) {
        throw new Error(`step ${i + 1}: tooltip top ${box.top} bottom ${box.bottom} vs viewport ${box.vh}, Skip visible ${box.skipVisible}`);
      }
      if (i < 11) {
        await page.getByRole("button", { name: "Next", exact: true }).click();
        await page.waitForTimeout(600);
      }
    }
    await page.getByRole("button", { name: "Finish", exact: true }).click();
    await page.getByText("Get to know Olaseena").waitFor({ state: "detached", timeout: 5000 });
  });
  await context.close();
}

/** v0.3.0 backup format 2: create a backup, check its ZIP layout in Node, restore it, then restore a v1 fixture. */
async function backupV2Checks(browser) {
  const V2_PATH = `${process.env.HOME}/workspace/olaseena-check-shots/backup-v2.zip`;
  const V1_FIXTURE = `${process.cwd()}/tests/fixtures/olaseena-backup-v1.zip`;

  async function openBackupDialog(page) {
    await nav(page, "Settings");
    await page.getByRole("button", { name: "Backup and restore" }).click();
  }

  async function applyRestore(page) {
    await page.getByText("File verified").waitFor({ timeout: 15000 });
    await page.getByRole("checkbox", { name: "Download a safety backup of my current data first" }).click();
    await page.getByRole("button", { name: "Apply changes", exact: true }).first().click();
    await page.getByRole("button", { name: "Apply changes", exact: true }).last().click();
    // The done panel has a Done button; "Backup restored" alone is ambiguous
    // because the toast and the panel title share the text.
    await page.getByRole("button", { name: "Done", exact: true }).waitFor({ timeout: 15000 });
    await page.getByRole("button", { name: "Close" }).click();
  }

  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    acceptDownloads: true,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  currentPage = page;
  const consoleErrors = [];
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(`console: ${m.text()}`);
  });

  await check("backup v2: seed a member and create a backup", async () => {
    await page.goto(`${BASE}/en`, { waitUntil: "networkidle" });
    await trackAlerts(page);
    await page.getByText("Get to know Olaseena").waitFor({ timeout: 8000 });
    await page.getByRole("button", { name: "Skip tour" }).click();
    await page.getByText("Get to know Olaseena").waitFor({ state: "detached", timeout: 5000 });
    await nav(page, "Members");
    await page.getByRole("button", { name: "Add member" }).click();
    await page.getByLabel("Name", { exact: true }).fill("Backup V2");
    await page.getByLabel("Email", { exact: true }).fill("backupv2@example.com");
    await page.getByRole("button", { name: "Save changes" }).click();
    await toast(page, "Saved");
    await openBackupDialog(page);
    const downloadPromise = page.waitForEvent("download", { timeout: 15000 });
    await page.getByRole("button", { name: "Create backup" }).click();
    const download = await downloadPromise;
    await page.getByText("Backup saved").waitFor({ timeout: 15000 });
    await download.saveAs(V2_PATH);
    if (!download.suggestedFilename().startsWith("olaseena-")) {
      throw new Error(`unexpected backup name: ${download.suggestedFilename()}`);
    }
    await page.getByRole("button", { name: "Close" }).click();
  });

  await check("backup v2: ZIP holds NDJSON files and a format 2 manifest", async () => {
    const files = unzipSync(readFileSync(V2_PATH));
    const names = Object.keys(files).sort();
    for (const needed of ["manifest.json", "database/members.ndjson", "database/attachments.ndjson", "settings/configuration.json"]) {
      if (!names.includes(needed)) throw new Error(`backup ZIP is missing ${needed}`);
    }
    if (names.includes("data.json")) throw new Error("backup ZIP still contains data.json");
    const manifest = JSON.parse(strFromU8(files["manifest.json"]));
    if (manifest.formatVersion !== 2) throw new Error(`manifest formatVersion is ${manifest.formatVersion}, expected 2`);
    if (manifest.schemaVersion !== 3) throw new Error(`manifest schemaVersion is ${manifest.schemaVersion}, expected 3`);
    if (manifest.stores.members.count < 1) throw new Error("manifest says no members were backed up");
    if (manifest.stores.attachments.count !== 0) throw new Error("manifest says attachments were backed up");
    for (const entry of manifest.files) {
      if (typeof entry.bytes !== "number" || !/^[0-9a-f]{64}$/.test(entry.sha256)) {
        throw new Error(`manifest file entry for ${entry.name} is missing bytes or sha256`);
      }
      if (entry.iv !== undefined) throw new Error(`unencrypted backup lists an IV for ${entry.name}`);
    }
    const config = JSON.parse(strFromU8(files["settings/configuration.json"]));
    if (!Array.isArray(config.settings)) throw new Error("settings/configuration.json does not hold a settings list");
    const memberLines = strFromU8(files["database/members.ndjson"]).split("\n").filter(Boolean);
    if (!memberLines.some((line) => line.includes("Backup V2"))) throw new Error("members.ndjson does not hold the seeded member");
  });

  await check("backup v2: delete the member, restore the backup, member returns", async () => {
    await nav(page, "Members");
    await page.locator("tr", { hasText: "Backup V2" }).getByRole("button", { name: "Delete member" }).click();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await toast(page, "Backup V2 moved to the trash bin");
    if (await page.locator("tr", { hasText: "Backup V2" }).count()) throw new Error("deleted member still listed");
    await openBackupDialog(page);
    await page.getByRole("tab", { name: "Restore" }).click();
    await page.getByRole("dialog").locator('input[type="file"]').setInputFiles(V2_PATH);
    await applyRestore(page);
    await nav(page, "Members");
    await page.getByText("Backup V2", { exact: true }).waitFor({ timeout: 8000 });
  });

  await check("backup v2: no console errors or page errors", async () => {
    if (consoleErrors.length) throw new Error(consoleErrors.slice(0, 3).join(" | "));
    const alerts = await page.evaluate(() => window.__alerts ?? []);
    if (alerts.length) throw new Error(`error toasts shown: ${alerts.slice(0, 3).join(" | ")}`);
  });
  await context.close();

  const oldContext = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    acceptDownloads: true,
  });
  const oldPage = await oldContext.newPage();
  oldPage.setDefaultTimeout(10000);
  currentPage = oldPage;
  const oldErrors = [];
  oldPage.on("pageerror", (e) => oldErrors.push(`pageerror: ${e.message}`));
  oldPage.on("console", (m) => {
    if (m.type() === "error") oldErrors.push(`console: ${m.text()}`);
  });

  await check("backup v1: old-format fixture still restores", async () => {
    await oldPage.goto(`${BASE}/en`, { waitUntil: "networkidle" });
    await trackAlerts(oldPage);
    await oldPage.getByText("Get to know Olaseena").waitFor({ timeout: 8000 });
    await oldPage.getByRole("button", { name: "Skip tour" }).click();
    await oldPage.getByText("Get to know Olaseena").waitFor({ state: "detached", timeout: 5000 });
    await openBackupDialog(oldPage);
    await oldPage.getByRole("tab", { name: "Restore" }).click();
    await oldPage.getByRole("dialog").locator('input[type="file"]').setInputFiles(V1_FIXTURE);
    await applyRestore(oldPage);
    await nav(oldPage, "Members");
    await oldPage.getByText("Ana", { exact: true }).waitFor({ timeout: 8000 });
    await nav(oldPage, "Courses");
    await oldPage.getByText("Piano Basics").waitFor({ timeout: 8000 });
  });

  await check("backup v1: no console errors or page errors", async () => {
    if (oldErrors.length) throw new Error(oldErrors.slice(0, 3).join(" | "));
    const alerts = await oldPage.evaluate(() => window.__alerts ?? []);
    if (alerts.length) throw new Error(`error toasts shown: ${alerts.slice(0, 3).join(" | ")}`);
  });
  await oldContext.close();
}

async function attachmentChecks(browser) {
  const ATT_BACKUP = `${process.env.HOME}/workspace/olaseena-check-shots/attachment-backup.zip`;
  const ATT_DOWNLOAD = `${process.env.HOME}/workspace/olaseena-check-shots/receipt-download.png`;

  async function openBackupDialog(page) {
    await nav(page, "Settings");
    await page.getByRole("button", { name: "Backup and restore" }).click();
  }

  async function applyRestore(page) {
    await page.getByText("File verified").waitFor({ timeout: 15000 });
    await page.getByRole("checkbox", { name: "Download a safety backup of my current data first" }).click();
    await page.getByRole("button", { name: "Apply changes", exact: true }).first().click();
    await page.getByRole("button", { name: "Apply changes", exact: true }).last().click();
    await page.getByRole("button", { name: "Done", exact: true }).waitFor({ timeout: 15000 });
    await page.getByRole("button", { name: "Close" }).click();
  }

  /** Generates an image in the page and picks it in the attachment file input, returning the picked file size. */
  async function pickImage(page, width, height, name) {
    return await page.evaluate(
      ({ width, height, name }) => {
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#5B2A52";
        ctx.fillRect(0, 0, width, height);
        ctx.fillStyle = "#F8F5F0";
        ctx.font = "48px sans-serif";
        ctx.fillText("Receipt", 40, 80);
        return new Promise((resolve) => {
          canvas.toBlob((blob) => {
            const file = new File([blob], name, { type: "image/png" });
            const dt = new DataTransfer();
            dt.items.add(file);
            const input = document.querySelector('input[aria-label="Add image"]');
            input.files = dt.files;
            input.dispatchEvent(new Event("change", { bubbles: true }));
            resolve(file.size);
          }, "image/png");
        });
      },
      { width, height, name },
    );
  }

  /** Picks a non-image file in the attachment file input. */
  async function pickTextFile(page) {
    await page.evaluate(() => {
      const file = new File(["not an image"], "notes.txt", { type: "text/plain" });
      const dt = new DataTransfer();
      dt.items.add(file);
      const input = document.querySelector('input[aria-label="Add image"]');
      input.files = dt.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }

  /** Scale of the image in the open lightbox, parsed from its transform. */
  async function lightboxScale(page) {
    return await page.evaluate(() => {
      const img = document.querySelector('[role="region"][aria-label$=".png"] img');
      const match = /scale\(([0-9.]+)\)/.exec(img?.style.transform ?? "");
      return match ? Number(match[1]) : 0;
    });
  }

  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    acceptDownloads: true,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  currentPage = page;
  const consoleErrors = [];
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(`console: ${m.text()}`);
  });

  await check("attachments: seed member and create invoice with a pending image", async () => {
    await page.goto(`${BASE}/en`, { waitUntil: "networkidle" });
    await trackAlerts(page);
    await page.getByText("Get to know Olaseena").waitFor({ timeout: 8000 });
    await page.getByRole("button", { name: "Skip tour" }).click();
    await page.getByText("Get to know Olaseena").waitFor({ state: "detached", timeout: 5000 });
    await nav(page, "Members");
    await page.getByRole("button", { name: "Add member" }).click();
    await page.getByLabel("Name", { exact: true }).fill("Attachment Ana");
    await page.getByLabel("Email", { exact: true }).fill("attachment@example.com");
    await page.getByRole("button", { name: "Save changes" }).click();
    await toast(page, "Saved");
    await nav(page, "Invoices");
    await page.getByRole("button", { name: "New invoice" }).click();
    await pickSelect(page, "Member", "Attachment Ana");
    await page.getByLabel("Description", { exact: true }).fill("Course fee");
    await page.getByLabel("Amount", { exact: true }).fill("100000");
    const size = await pickImage(page, 800, 600, "receipt.png");
    if (size <= 0) throw new Error("generated test image is empty");
    await page.getByRole("img", { name: "receipt.png" }).first().waitFor({ timeout: 8000 });
    await page.getByRole("button", { name: "Create invoice" }).click();
    await toast(page, "Saved");
    await page.locator("tr", { hasText: "Attachment Ana" }).first().click();
    await page.getByRole("button", { name: "View attachment: receipt.png" }).waitFor({ timeout: 8000 });
  });

  await check("attachments: non-image file is rejected with a plain message", async () => {
    await pickTextFile(page);
    await page.getByText("Only images can be attached").waitFor({ timeout: 8000 });
    if ((await page.getByRole("button", { name: /View attachment/ }).count()) !== 1) {
      throw new Error("rejected file still produced a thumbnail");
    }
  });

  await check("attachments: oversized image is rejected after shrinking", async () => {
    // No real photo stays over 4 MB after the 1920px JPEG shrink, so the
    // shrink step is stubbed to return a 5 MB blob for this check only; the
    // unit tests cover the real size math. Only the JPEG re-encode is
    // stubbed: the test image itself is still generated as a real PNG.
    await page.evaluate(() => {
      window.__origToBlob = HTMLCanvasElement.prototype.toBlob;
      HTMLCanvasElement.prototype.toBlob = function (cb, type, quality) {
        if (type === "image/jpeg") {
          cb(new Blob([new Uint8Array(5 * 1024 * 1024)], { type: "image/jpeg" }));
        } else {
          window.__origToBlob.call(this, cb, type, quality);
        }
      };
    });
    try {
      await pickImage(page, 3000, 2000, "big.png");
      await page.getByText("is still larger than 4 MB after shrinking.").waitFor({ timeout: 8000 });
    } finally {
      await page.evaluate(() => {
        HTMLCanvasElement.prototype.toBlob = window.__origToBlob;
      });
    }
    if ((await page.getByRole("button", { name: /View attachment/ }).count()) !== 1) {
      throw new Error("rejected file still produced a thumbnail");
    }
    // The two rejections above raised expected error toasts and console
    // lines; drop exactly those two expected entries so the final no-errors
    // check only sees unexpected ones.
    await page.evaluate(() => {
      window.__alerts = [];
    });
    for (let i = consoleErrors.length - 1; i >= 0; i--) {
      if (
        consoleErrors[i].includes("during attachment.add") &&
        (consoleErrors[i].includes("Only images can be attached") || consoleErrors[i].includes("larger than 4 MB after shrinking"))
      ) {
        consoleErrors.splice(i, 1);
      }
    }
  });

  await check("attachments: viewer opens, zooms with button and wheel, closes with Escape", async () => {
    await page.getByRole("button", { name: "View attachment: receipt.png" }).click();
    await page.getByRole("dialog", { name: "receipt.png" }).waitFor({ timeout: 8000 });
    if ((await lightboxScale(page)) !== 1) throw new Error("lightbox did not start at scale 1");
    await page.getByRole("button", { name: "Zoom in" }).click();
    const afterButton = await lightboxScale(page);
    if (Math.abs(afterButton - 1.33) > 0.01) throw new Error(`zoom-in button left scale at ${afterButton}, expected 1.33`);
    await page.mouse.move(640, 400);
    await page.mouse.wheel(0, -600);
    await page.waitForTimeout(300);
    const afterWheel = await lightboxScale(page);
    if (afterWheel <= afterButton) throw new Error(`wheel zoom did not grow the scale (${afterWheel} <= ${afterButton})`);
    await page.keyboard.press("Escape");
    await page.getByRole("dialog", { name: "receipt.png" }).waitFor({ state: "detached", timeout: 5000 });
  });

  await check("attachments: viewer download saves the file, delete removes it", async () => {
    await page.getByRole("button", { name: "View attachment: receipt.png" }).click();
    await page.getByRole("dialog", { name: "receipt.png" }).waitFor({ timeout: 8000 });
    const downloadPromise = page.waitForEvent("download", { timeout: 15000 });
    await page.getByRole("button", { name: "Download" }).click();
    const download = await downloadPromise;
    await download.saveAs(ATT_DOWNLOAD);
    if (download.suggestedFilename() !== "receipt.png") throw new Error(`unexpected download name: ${download.suggestedFilename()}`);
    if (statSync(ATT_DOWNLOAD).size <= 0) throw new Error("downloaded attachment is empty");
    await page.getByRole("button", { name: "Delete attachment" }).click();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    // The lightbox closes on delete; wait for it to leave the DOM before
    // touching the detail modal behind it, whose Close button shares the
    // same accessible name as the lightbox close button.
    await page.getByRole("dialog", { name: "receipt.png" }).waitFor({ state: "detached", timeout: 8000 });
    await page.getByText("No attachments yet").waitFor({ timeout: 8000 });
    await toast(page, "Deleted");
    // The detail modal has two Close buttons (icon + footer text); the
    // suite's established pattern picks the footer one.
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
  });

  await check("attachments: backup ZIP holds the file as a real asset", async () => {
    await page.locator("tr", { hasText: "Attachment Ana" }).first().click();
    const size = await pickImage(page, 800, 600, "receipt-2.png");
    if (size <= 0) throw new Error("generated test image is empty");
    await page.getByRole("button", { name: "View attachment: receipt-2.png" }).waitFor({ timeout: 8000 });
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
    await openBackupDialog(page);
    const downloadPromise = page.waitForEvent("download", { timeout: 15000 });
    await page.getByRole("button", { name: "Create backup" }).click();
    const download = await downloadPromise;
    await page.getByText("Backup saved").waitFor({ timeout: 15000 });
    await download.saveAs(ATT_BACKUP);
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
    const files = unzipSync(readFileSync(ATT_BACKUP));
    const manifest = JSON.parse(strFromU8(files["manifest.json"]));
    if (manifest.schemaVersion !== 3) throw new Error(`manifest schemaVersion is ${manifest.schemaVersion}, expected 3`);
    if (manifest.stores.attachments.count !== 1) throw new Error(`manifest says ${manifest.stores.attachments.count} attachments, expected 1`);
    const lines = strFromU8(files["database/attachments.ndjson"]).split("\n").filter(Boolean);
    if (lines.length !== 1) throw new Error(`attachments.ndjson holds ${lines.length} rows, expected 1`);
    const row = JSON.parse(lines[0]);
    if (row.fileName !== "receipt-2.png") throw new Error(`attachments.ndjson holds ${row.fileName}, expected receipt-2.png`);
    const assetName = `assets/images/${row.id}.png`;
    if (!files[assetName] || files[assetName].length === 0) throw new Error(`backup ZIP is missing a real file at ${assetName}`);
  });

  await check("attachments: restore brings the invoice and its file back", async () => {
    await nav(page, "Invoices");
    await page.locator("tr", { hasText: "Attachment Ana" }).first().click();
    await page.getByRole("button", { name: "Delete invoice" }).click();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.locator('[role="status"]', { hasText: "moved to the trash bin" }).first().waitFor({ timeout: 8000 });
    if (await page.getByText("Attachment Ana").count()) throw new Error("deleted invoice still listed");
    await openBackupDialog(page);
    await page.getByRole("tab", { name: "Restore" }).click();
    await page.getByRole("dialog").locator('input[type="file"]').setInputFiles(ATT_BACKUP);
    await applyRestore(page);
    await nav(page, "Invoices");
    await page.getByText("Attachment Ana", { exact: true }).waitFor({ timeout: 8000 });
    await page.locator("tr", { hasText: "Attachment Ana" }).first().click();
    await page.getByRole("button", { name: "View attachment: receipt-2.png" }).waitFor({ timeout: 8000 });
    await page.getByRole("button", { name: "View attachment: receipt-2.png" }).click();
    await page.getByRole("dialog", { name: "receipt-2.png" }).waitFor({ timeout: 8000 });
    if ((await lightboxScale(page)) !== 1) throw new Error("restored attachment did not open in the viewer");
    await page.keyboard.press("Escape");
    await page.getByRole("dialog", { name: "receipt-2.png" }).waitFor({ state: "detached", timeout: 5000 });
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
  });

  await check("attachments: no console errors or page errors", async () => {
    if (consoleErrors.length) throw new Error(consoleErrors.slice(0, 3).join(" | "));
    const alerts = await page.evaluate(() => window.__alerts ?? []);
    if (alerts.length) throw new Error(`error toasts shown: ${alerts.slice(0, 3).join(" | ")}`);
  });
  await context.close();
}

/** v0.4.0 trash bin: delete moves a record to trash, restore brings it back, permanent delete removes it, retention switches 7/30 days. */
async function trashChecks(browser) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    acceptDownloads: true,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  currentPage = page;
  const consoleErrors = [];
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(`console: ${m.text()}`);
  });

  async function openTrash() {
    await nav(page, "Trash");
    await page.getByText("Trash bin").first().waitFor();
  }

  /** Switches the retention setting, which lives in Settings as "7 days" / "30 days" buttons. */
  async function setRetention(days) {
    await nav(page, "Settings");
    await page.getByRole("button", { name: `${days} days`, exact: true }).click();
  }

  await check("trash: create a member and delete it to the trash bin", async () => {
    await page.goto(`${BASE}/en`, { waitUntil: "networkidle" });
    await trackAlerts(page);
    await page.getByText("Get to know Olaseena").waitFor({ timeout: 8000 });
    await page.getByRole("button", { name: "Skip tour" }).click();
    await page.getByText("Get to know Olaseena").waitFor({ state: "detached", timeout: 5000 });
    await nav(page, "Members");
    await page.getByRole("button", { name: "Add member" }).click();
    await page.getByLabel("Name", { exact: true }).fill("Trash Test Member");
    await page.getByLabel("Email", { exact: true }).fill("trashtest@example.com");
    await page.getByRole("button", { name: "Save changes" }).click();
    await toast(page, "Saved");
    await page.locator("tr", { hasText: "Trash Test Member" }).waitFor();
    await page.locator("tr", { hasText: "Trash Test Member" }).getByRole("button", { name: "Delete member" }).click();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await toast(page, "Trash Test Member moved to the trash bin");
    if (await page.locator("tr", { hasText: "Trash Test Member" }).count()) throw new Error("deleted member still listed");
  });

  await check("trash: entry is listed with kind, label and days remaining", async () => {
    await openTrash();
    await page.getByText("Member: Trash Test Member").waitFor({ timeout: 8000 });
    await page.getByText("7 days left").waitFor();
    await page.getByText("Deleted records are kept for 7 days, then automatically removed.").waitFor();
    await noOverflow(page, "trash bin", 1280);
  });

  await check("trash: restore returns the member to the Members list", async () => {
    await page.getByRole("button", { name: "Restore" }).first().click();
    await toast(page, "Restored Trash Test Member");
    await nav(page, "Members");
    await page.locator("tr", { hasText: "Trash Test Member" }).waitFor({ timeout: 8000 });
  });

  await check("trash: delete again, then delete permanently behind confirm", async () => {
    await page.locator("tr", { hasText: "Trash Test Member" }).getByRole("button", { name: "Delete member" }).click();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await toast(page, "Trash Test Member moved to the trash bin");
    await openTrash();
    await page.getByText("Member: Trash Test Member").waitFor({ timeout: 8000 });
    await page.getByRole("button", { name: "Delete permanently" }).first().click();
    await page.getByText("Permanently delete this item?").waitFor({ timeout: 5000 });
    await page.getByRole("alertdialog").getByRole("button", { name: "Delete permanently", exact: true }).click();
    await page.getByText("Trash is empty.").waitFor({ timeout: 8000 });
    if (await page.getByText("Member: Trash Test Member").count()) throw new Error("permanently deleted entry still listed");
  });

  await check("trash: retention switches 7 to 30 days and back", async () => {
    await setRetention(30);
    await openTrash();
    await page.getByText("Deleted records are kept for 30 days, then automatically removed.").waitFor({ timeout: 8000 });
    await setRetention(7);
    await openTrash();
    await page.getByText("Deleted records are kept for 7 days, then automatically removed.").waitFor({ timeout: 8000 });
  });

  await check("trash: no console errors or page errors", async () => {
    if (consoleErrors.length) throw new Error(consoleErrors.slice(0, 3).join(" | "));
    const alerts = await page.evaluate(() => window.__alerts ?? []);
    if (alerts.length) throw new Error(`error toasts shown: ${alerts.slice(0, 3).join(" | ")}`);
  });
  await context.close();
}

/** v0.9.0 skills: tag input suggestions and create-new, ranked trainer picker, none-qualified message, standalone session form. */
async function skillsSessionChecks(browser) {
  const todayShort = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date().getDay()];
  // Same weekday next week: always on-slot for a course that meets today,
  // and a different date from any session created for today.
  const nextWeek = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  async function addTrainer(page, name, subjects) {
    await page.getByRole("button", { name: "Add trainer" }).click();
    await page.getByLabel("Name", { exact: true }).fill(name);
    await page.getByLabel("Email", { exact: true }).fill(`${name.split(" ")[0].toLowerCase()}@example.com`);
    for (const skill of subjects) {
      await page.getByLabel("Subjects", { exact: true }).fill(skill);
      await page.keyboard.press("Enter");
    }
    await page.getByLabel("Rate per session (IDR)", { exact: true }).fill("150000");
    await page.getByRole("button", { name: "Save changes" }).click();
    await toast(page, "Saved");
  }

  async function addCourse(page, title, skills) {
    await page.getByRole("button", { name: "Add course" }).click();
    await page.getByLabel("Title", { exact: true }).fill(title);
    await page.getByLabel("Level", { exact: true }).fill("Beginner");
    await page.getByLabel("Price (IDR)", { exact: true }).fill("500000");
    for (const skill of skills) await addRequiredSkill(page, skill);
    await page.getByRole("checkbox", { name: todayShort }).check();
    await page.getByRole("button", { name: "Save changes" }).click();
    await toast(page, "Saved");
  }

  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  currentPage = page;
  const consoleErrors = [];
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(`console: ${m.text()}`);
  });

  await check("skills: tag input suggests an existing skill and creates a new one", async () => {
    await page.goto(`${BASE}/en`, { waitUntil: "networkidle" });
    await trackAlerts(page);
    await page.getByText("Get to know Olaseena").waitFor({ timeout: 8000 });
    await page.getByRole("button", { name: "Skip tour" }).click();
    await nav(page, "Trainers");
    await addTrainer(page, "Budi Santoso", ["Piano", "Guitar"]);
    await addTrainer(page, "Siti Rahma", ["Guitar"]);
    await addTrainer(page, "Dewi Lestari", ["Drums"]);

    await nav(page, "Courses");
    await page.getByRole("button", { name: "Add course" }).click();
    await page.getByLabel("Title", { exact: true }).fill("Music Skills");
    await page.getByLabel("Level", { exact: true }).fill("Beginner");
    await page.getByLabel("Price (IDR)", { exact: true }).fill("500000");
    // Suggestion drawn from the trainers' subjects: typing "Pia" offers Piano.
    await page.getByLabel("Required skills", { exact: true }).fill("Pia");
    await page.getByRole("option", { name: "Piano", exact: true }).click();
    await page.getByRole("button", { name: "Remove Piano" }).waitFor();
    // A skill nobody uses yet is offered as a create row instead.
    await page.getByLabel("Required skills", { exact: true }).fill("Cello");
    await page.getByRole("option", { name: "Add “Cello”", exact: true }).waitFor();
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "Remove Cello" }).waitFor();
    // The new skill is removable too: drop it again, then add the second
    // skill the trainers teach via a suggestion, so the course requires
    // Piano and Guitar.
    await page.getByRole("button", { name: "Remove Cello" }).click();
    await page.getByRole("button", { name: "Remove Cello" }).waitFor({ state: "detached" });
    await page.getByLabel("Required skills", { exact: true }).fill("Gui");
    await page.getByRole("option", { name: "Guitar", exact: true }).click();
    await page.getByRole("button", { name: "Remove Guitar" }).waitFor();
    await page.getByRole("checkbox", { name: todayShort }).check();
    await page.getByRole("button", { name: "Save changes" }).click();
    await toast(page, "Saved");
    await page.locator("tr", { hasText: "Music Skills" }).waitFor();
    await page.getByText("Piano, Guitar").waitFor();
    await noOverflow(page, "courses with skills", 1280);
  });

  await check("skills: standalone session ranks trainers by match count and excludes zero-match", async () => {
    await page.getByRole("button", { name: "New session", exact: true }).first().click();
    await page.getByText("Choose a course first to see which trainers qualify.").waitFor();
    await pickSelect(page, "Course", "Music Skills");
    await page.getByText("Required skills: Piano, Guitar").waitFor();
    const order = await page.evaluate(() => {
      const group = document.querySelector('[role="radiogroup"]');
      return [...(group?.querySelectorAll("label") ?? [])].map((l) => l.textContent ?? "");
    });
    if (order.length !== 2) throw new Error(`expected 2 qualified trainers, got ${order.length}: ${order.join(" | ")}`);
    if (!order[0].includes("Budi Santoso") || !order[0].includes("Matches 2 of 2 required skills")) {
      throw new Error(`richer trainer should be first with 2 matches, got: ${order[0]}`);
    }
    if (!order[1].includes("Siti Rahma") || !order[1].includes("Matches 1 of 2 required skills")) {
      throw new Error(`second trainer should be Siti with 1 match, got: ${order[1]}`);
    }
    if (order.join(" ").includes("Dewi")) throw new Error("zero-match trainer Dewi is listed");
    await page.getByLabel("Topic", { exact: true }).fill("Ranked session");
    await pickTime(page, "Start time", "10:00");
    await pickTime(page, "End time", "11:00");
    await page.getByRole("radio", { name: "Budi Santoso" }).click();
    await page.getByRole("button", { name: "Add", exact: true }).last().click();
    await toast(page, "Saved");
    await noOverflow(page, "standalone session", 1280);
  });

  await check("skills: none-qualified message shows and the session cannot be submitted", async () => {
    // Close any modal a previous check left open, so this check starts on the list screen.
    const cancel = page.getByRole("button", { name: "Cancel", exact: true });
    if (await cancel.count()) await cancel.first().click().catch(() => {});
    await addCourse(page, "Harp Basics", ["Harp"]);
    await page.getByRole("button", { name: "New session", exact: true }).first().click();
    await pickSelect(page, "Course", "Harp Basics");
    await page.getByText("No trainer teaches any of the skills this course requires.").waitFor();
    if (!(await page.getByRole("button", { name: "Add", exact: true }).last().isDisabled())) {
      throw new Error("Add is enabled with no qualified trainer");
    }
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
  });

  await check("skills: course-detail session form picks a qualified trainer too", async () => {
    const cancel = page.getByRole("button", { name: "Cancel", exact: true });
    if (await cancel.count()) await cancel.first().click().catch(() => {});
    await page.locator("tr", { hasText: "Music Skills" }).click();
    await page.getByText("Enrollments").first().waitFor();
    await page.getByRole("button", { name: "New session" }).click();
    // Today already has the standalone session for this course (one session
    // per course per date), so use the same weekday next week instead.
    await pickDate(page, nextWeek);
    await page.getByLabel("Topic", { exact: true }).fill("Detail session");
    await pickTime(page, "Start time", "10:00");
    await pickTime(page, "End time", "11:00");
    await page.getByRole("radio", { name: "Siti Rahma" }).click();
    await page.getByRole("button", { name: "Add", exact: true }).last().click();
    await toast(page, "Saved");
    // The session also appears in the Sessions section behind this dialog, so scope to the dialog.
    await page.locator('[role="dialog"]').getByText("Detail session").waitFor();
    await page.getByRole("button", { name: "Close", exact: true }).last().click();
  });

  await check("skills: no console errors or page errors", async () => {
    if (consoleErrors.length) throw new Error(consoleErrors.slice(0, 3).join(" | "));
    const alerts = await page.evaluate(() => window.__alerts ?? []);
    if (alerts.length) throw new Error(`error toasts shown: ${alerts.slice(0, 3).join(" | ")}`);
  });
  await context.close();

  const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const mobilePage = await mobileContext.newPage();
  mobilePage.setDefaultTimeout(10000);
  currentPage = mobilePage;
  const mobileErrors = [];
  mobilePage.on("pageerror", (e) => mobileErrors.push(`pageerror: ${e.message}`));
  mobilePage.on("console", (m) => {
    if (m.type() === "error") mobileErrors.push(`console: ${m.text()}`);
  });

  await check("skills mobile: standalone session form fits 390px and saves", async () => {
    await mobilePage.goto(`${BASE}/en`, { waitUntil: "networkidle" });
    await trackAlerts(mobilePage);
    await mobilePage.getByText("Get to know Olaseena").waitFor({ timeout: 8000 });
    await mobilePage.getByRole("button", { name: "Skip tour" }).click();
    const go = async (name) => {
      if (name === "Trainers") {
        await mobilePage.getByRole("button", { name: "More", exact: true }).click();
        await mobilePage.getByRole("button", { name, exact: true }).click();
      } else {
        await nav(mobilePage, name);
      }
    };
    await go("Trainers");
    await addTrainer(mobilePage, "Budi Santoso", ["Piano"]);
    await nav(mobilePage, "Courses");
    await addCourse(mobilePage, "Piano Basics", ["Piano"]);
    await mobilePage.getByRole("button", { name: "New session", exact: true }).first().click();
    await pickSelect(mobilePage, "Course", "Piano Basics");
    await mobilePage.getByLabel("Topic", { exact: true }).fill("Mobile session");
    await pickTime(mobilePage, "Start time", "10:00");
    await pickTime(mobilePage, "End time", "11:00");
    await mobilePage.getByRole("radio", { name: "Budi Santoso" }).click();
    await noOverflow(mobilePage, "standalone session mobile", 390);
    await mobilePage.getByRole("button", { name: "Add", exact: true }).last().click();
    await toast(mobilePage, "Saved");
    await noOverflow(mobilePage, "courses mobile after session", 390);
  });

  await check("skills mobile: no console errors or page errors", async () => {
    if (mobileErrors.length) throw new Error(mobileErrors.slice(0, 3).join(" | "));
    const alerts = await mobilePage.evaluate(() => window.__alerts ?? []);
    if (alerts.length) throw new Error(`error toasts shown: ${alerts.slice(0, 3).join(" | ")}`);
  });
  await mobileContext.close();
}

async function capacityChecks(browser) {
  const todayShort = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date().getDay()];

  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  currentPage = page;
  const consoleErrors = [];
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(`console: ${m.text()}`);
  });

  await check("capacity: capped session refuses the next attending mark and frees the place", async () => {
    await page.goto(`${BASE}/en`, { waitUntil: "networkidle" });
    await trackAlerts(page);
    await page.getByText("Get to know Olaseena").waitFor({ timeout: 8000 });
    await page.getByRole("button", { name: "Skip tour" }).click();

    await nav(page, "Members");
    for (const name of ["Ana", "Budi"]) {
      await page.getByRole("button", { name: "Add member" }).click();
      await page.getByLabel("Name", { exact: true }).fill(name);
      await page.getByLabel("Email", { exact: true }).fill(`${name.toLowerCase()}@example.com`);
      await page.getByLabel("Phone", { exact: true }).fill("081234567890");
      await page.getByRole("button", { name: "Save changes" }).click();
      await toast(page, "Saved");
      await page.getByText(name, { exact: true }).waitFor();
    }

    await nav(page, "Trainers");
    await page.getByRole("button", { name: "Add trainer" }).click();
    await page.getByLabel("Name", { exact: true }).fill("Dewi Lestari");
    await page.getByLabel("Email", { exact: true }).fill("dewi@example.com");
    await page.getByLabel("Subjects", { exact: true }).fill("Piano");
    await page.keyboard.press("Enter");
    await page.getByLabel("Rate per session (IDR)", { exact: true }).fill("150000");
    await page.getByRole("button", { name: "Save changes" }).click();
    await toast(page, "Saved");

    await nav(page, "Courses");
    await page.getByRole("button", { name: "Add course" }).click();
    await page.getByLabel("Title", { exact: true }).fill("Small Group");
    await page.getByLabel("Level", { exact: true }).fill("Beginner");
    await page.getByLabel("Price (IDR)", { exact: true }).fill("500000");
    // No required skills: any trainer qualifies. The course form no longer
    // has a capacity field, so the cap lives on the session instead.
    if (await page.getByLabel("Capacity", { exact: true }).count()) throw new Error("course form still has a capacity field");
    await page.getByRole("checkbox", { name: todayShort }).check();
    await page.getByRole("button", { name: "Save changes" }).click();
    await toast(page, "Saved");
    await page.locator("tr", { hasText: "Small Group" }).click();
    await page.getByText("Enrollments").first().waitFor();
    for (const name of ["Ana", "Budi"]) {
      await page.getByRole("button", { name: "Enroll member" }).click();
      await pickSelect(page, "Member", name);
      await page.getByRole("button", { name: "Add", exact: true }).last().click();
      await toast(page, "Saved");
      await page.getByText(name, { exact: true }).waitFor();
    }
    await page.getByRole("button", { name: "Close", exact: true }).last().click();

    // The session form's capacity field starts blank (no limit); set it to 1.
    await nav(page, "Attendance");
    await pickSessionCourse(page, "Small Group");
    await page.getByRole("button", { name: "New session" }).click();
    await page.getByLabel("Topic", { exact: true }).fill("Trio");
    const capInput = page.getByLabel("Capacity", { exact: true });
    await capInput.waitFor();
    if ((await capInput.inputValue()) !== "") throw new Error("session capacity field is not blank by default");
    // The hint lives behind the field's "?" toggletip, like every other hint.
    await page.getByRole("button", { name: "More about Capacity" }).click();
    await page.getByText("Leave blank for no limit.").waitFor();
    await capInput.fill("1");
    await pickTime(page, "Start time", "10:00");
    await pickTime(page, "End time", "11:00");
    await page.getByRole("radio", { name: "Dewi Lestari" }).click();
    await page.getByRole("button", { name: "Add", exact: true }).last().click();
    await toast(page, "Saved");
    await page.locator("p", { hasText: "Trio" }).waitFor();

    // The cap is already reached by the default marks, so the member without
    // a place cannot be marked present or late, only absent. Which member
    // holds the place depends on enrollment order (ids are random UUIDs), so
    // read it from the UI instead of assuming Ana is first.
    await page.getByText("This session is full: 1 of 1 places are already taken.").waitFor();
    const holder = (await page.getByRole("radiogroup", { name: "Ana" }).getByRole("radio", { name: "Present" }).getAttribute("aria-checked")) === "true" ? "Ana" : "Budi";
    const other = holder === "Ana" ? "Budi" : "Ana";
    const otherPresent = page.getByRole("radiogroup", { name: other }).getByRole("radio", { name: "Present" });
    const otherLate = page.getByRole("radiogroup", { name: other }).getByRole("radio", { name: "Late" });
    const otherAbsent = page.getByRole("radiogroup", { name: other }).getByRole("radio", { name: "Absent" });
    if (!(await otherPresent.isDisabled())) throw new Error(`Present is enabled for ${other} past the cap`);
    if (!(await otherLate.isDisabled())) throw new Error(`Late is enabled for ${other} past the cap`);
    if (await otherAbsent.isDisabled()) throw new Error(`Absent is disabled for ${other} past the cap`);
    await page.getByRole("button", { name: "Mark attendance" }).click();
    await toast(page, "Attendance saved");

    // Freeing the holder's place lets the other member take it.
    await page.getByRole("radiogroup", { name: holder }).getByRole("radio", { name: "Absent" }).click();
    await page.getByText("0 of 1 attending").waitFor();
    if (await otherPresent.isDisabled()) throw new Error(`Present is still disabled for ${other} after a place freed up`);
    await otherPresent.click();
    await page.getByText("This session is full: 1 of 1 places are already taken.").waitFor();
    await page.getByRole("button", { name: "Mark attendance" }).click();
    await toast(page, "Attendance saved");
    await noOverflow(page, "attendance capped", 1280);
  });

  await check("capacity: no console errors or page errors", async () => {
    if (consoleErrors.length) throw new Error(consoleErrors.slice(0, 3).join(" | "));
    const alerts = await page.evaluate(() => window.__alerts ?? []);
    if (alerts.length) throw new Error(`error toasts shown: ${alerts.slice(0, 3).join(" | ")}`);
  });
  await context.close();

  const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const mobilePage = await mobileContext.newPage();
  mobilePage.setDefaultTimeout(10000);
  currentPage = mobilePage;
  const mobileErrors = [];
  mobilePage.on("pageerror", (e) => mobileErrors.push(`pageerror: ${e.message}`));
  mobilePage.on("console", (m) => {
    if (m.type() === "error") mobileErrors.push(`console: ${m.text()}`);
  });

  await check("capacity mobile: session capacity field fits 390px and saves", async () => {
    await mobilePage.goto(`${BASE}/en`, { waitUntil: "networkidle" });
    await trackAlerts(mobilePage);
    await mobilePage.getByText("Get to know Olaseena").waitFor({ timeout: 8000 });
    await mobilePage.getByRole("button", { name: "Skip tour" }).click();
    const go = async (name) => {
      if (name === "Trainers") {
        await mobilePage.getByRole("button", { name: "More", exact: true }).click();
        await mobilePage.getByRole("button", { name, exact: true }).click();
      } else {
        await nav(mobilePage, name);
      }
    };
    await go("Trainers");
    await mobilePage.getByRole("button", { name: "Add trainer" }).click();
    await mobilePage.getByLabel("Name", { exact: true }).fill("Dewi Lestari");
    await mobilePage.getByLabel("Email", { exact: true }).fill("dewi@example.com");
    await mobilePage.getByLabel("Subjects", { exact: true }).fill("Piano");
    await mobilePage.keyboard.press("Enter");
    await mobilePage.getByLabel("Rate per session (IDR)", { exact: true }).fill("150000");
    await mobilePage.getByRole("button", { name: "Save changes" }).click();
    await toast(mobilePage, "Saved");
    await nav(mobilePage, "Courses");
    await mobilePage.getByRole("button", { name: "Add course" }).click();
    await mobilePage.getByLabel("Title", { exact: true }).fill("Small Group");
    await mobilePage.getByLabel("Level", { exact: true }).fill("Beginner");
    await mobilePage.getByLabel("Price (IDR)", { exact: true }).fill("500000");
    await mobilePage.getByRole("checkbox", { name: todayShort }).check();
    await mobilePage.getByRole("button", { name: "Save changes" }).click();
    await toast(mobilePage, "Saved");
    await mobilePage.getByRole("button", { name: "New session", exact: true }).first().click();
    await pickSelect(mobilePage, "Course", "Small Group");
    await mobilePage.getByLabel("Topic", { exact: true }).fill("Mobile trio");
    await mobilePage.getByLabel("Capacity", { exact: true }).fill("2");
    await pickTime(mobilePage, "Start time", "10:00");
    await pickTime(mobilePage, "End time", "11:00");
    await mobilePage.getByRole("radio", { name: "Dewi Lestari" }).click();
    await noOverflow(mobilePage, "standalone session with capacity mobile", 390);
    await mobilePage.getByRole("button", { name: "Add", exact: true }).last().click();
    await toast(mobilePage, "Saved");
    await noOverflow(mobilePage, "courses mobile after capped session", 390);
  });

  await check("capacity mobile: no console errors or page errors", async () => {
    if (mobileErrors.length) throw new Error(mobileErrors.slice(0, 3).join(" | "));
    const alerts = await mobilePage.evaluate(() => window.__alerts ?? []);
    if (alerts.length) throw new Error(`error toasts shown: ${alerts.slice(0, 3).join(" | ")}`);
  });
  await mobileContext.close();
}

const browser = await chromium.launch(launchOptions());
try {
  await desktop(browser);
  await weeklySlotChecks(browser);
  await timePickerChecks(browser);
  await skillsSessionChecks(browser);
  await capacityChecks(browser);
  await printChecks(browser);
  await darkDesktop(browser);
  await currencyChecks(browser);
  await mobile(browser);
  await shortViewportTour(browser);
  await mobileTourSheet(browser);
  await mobileTourShortPhone(browser);
  await mobileScreensWithData(browser);
  await mobileDarkMode(browser);
  await backupV2Checks(browser);
  await attachmentChecks(browser);
  await trashChecks(browser);
} finally {
  await browser.close();
}

console.log(results.join("\n"));
console.log(`\n${results.length - failures}/${results.length} checks passed`);
if (failures) process.exit(1);
