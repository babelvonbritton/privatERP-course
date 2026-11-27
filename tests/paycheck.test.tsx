// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { getServices, resetServices } from "@/lib/domain/services";
import { getStorage, resetStorage } from "@/lib/storage";
import { createId } from "@/lib/storage/utils";
import { PaycheckDocument } from "@/components/payroll/PaycheckDocument";
import { PayrollScreen } from "@/components/screens/PayrollScreen";
import type { Course, PayrollRun, Session } from "@/lib/domain/types";
import type { BusinessProfile } from "@/lib/storage/BusinessProfileService";
import { Providers } from "./support";

function stubRadix() {
  window.HTMLElement.prototype.scrollIntoView = function () {};
  window.HTMLElement.prototype.hasPointerCapture = function () { return false; };
  window.HTMLElement.prototype.releasePointerCapture = function () {};
}

afterEach(() => cleanup());

async function freshServices() {
  await resetStorage();
  resetServices();
  return getServices();
}

const trainer = (name: string, ratePerSession = 150000) => ({
  name,
  email: `${name.toLowerCase()}@example.com`,
  phone: "0812000001",
  subjects: ["Piano"],
  ratePerSession,
  status: "active" as const,
  idempotencyKey: createId(),
});

const member = (name: string) => ({
  name,
  email: `${name.toLowerCase()}@example.com`,
  phone: "0812000000",
  notes: "",
  status: "active" as const,
  idempotencyKey: createId(),
});

const profile: BusinessProfile = {
  businessName: "Melody Studio",
  ownerName: "Rina Hartono",
  address: "Jl. Melati 12, Bandung",
  contacts: ["081234567890"],
  tagline: "Music lessons for every age",
  logoAttachmentId: null,
};

/** 2026-11-09 and 2026-11-16 are Mondays, on the course's slot. Seeds a run with one paid and one unpaid session. */
async function seedRun() {
  const s = await freshServices();
  const t = await s.trainers.create(trainer("Budi"));
  const m = await s.members.create(member("Ana"));
  const c = await s.courses.create({ title: "Piano Basics", description: "", level: "Beginner", price: 500000, requiredSkills: ["Piano"], scheduleWeekdays: [1], status: "active", idempotencyKey: createId() });
  await s.courses.enroll({ memberId: m.id, courseId: c.id, startDate: "2026-11-02", endDate: null, status: "active", idempotencyKey: createId() });
  const paid = await s.attendance.createSession({ courseId: c.id, date: "2026-11-09", topic: "Scales", trainerId: t.id, trainerPresent: true, startTime: "09:00", endTime: "10:30", idempotencyKey: createId() });
  const unpaid = await s.attendance.createSession({ courseId: c.id, date: "2026-11-16", topic: "Arpeggios", trainerId: t.id, trainerPresent: false, startTime: "09:00", endTime: "10:30", idempotencyKey: createId() });
  await s.attendance.assignSessionAttendees(paid.id, [m.id], createId());
  await s.attendance.assignSessionAttendees(unpaid.id, [m.id], createId());
  await s.attendance.mark(paid.id, [{ memberId: m.id, status: "present" }], createId());
  await s.attendance.mark(unpaid.id, [{ memberId: m.id, status: "present" }], createId());
  const run = await s.payroll.generate({ trainerId: t.id, periodStart: "2026-11-01", periodEnd: "2026-11-30", idempotencyKey: createId() });
  return { s, t, m, c, paid, unpaid, run };
}

function docProps(run: PayrollRun, paid: Session, unpaid: Session, c: Course) {
  return {
    run,
    trainerName: "Budi",
    paidSessions: [paid],
    unpaidSessions: [unpaid],
    courseById: new Map([[c.id, c]]),
    profile,
  };
}

describe("PaycheckDocument", () => {
  it("a draft shows the trainer, the itemized sessions, the total, and a Draft label", async () => {
    const { paid, unpaid, c, run } = await seedRun();
    expect(run.status).toBe("draft");
    const { container } = render(
      <Providers>
        <PaycheckDocument {...docProps(run, paid, unpaid, c)} />
      </Providers>,
    );
    const scope = within(container);
    expect(scope.getByTestId("paycheck-document")).toBeTruthy();
    expect(scope.getByText("Paycheck")).toBeTruthy();
    expect(scope.getByText("Draft")).toBeTruthy();
    expect(scope.queryByText("Paid", { exact: true })).toBeNull();
    expect(scope.getByText("Budi")).toBeTruthy();
    expect(scope.getByText(/Nov 9, 2026/)).toBeTruthy();
    expect(scope.getByText("Scales")).toBeTruthy();
    expect(scope.getByText("Piano Basics")).toBeTruthy();
    expect(scope.getByText("1.5 h")).toBeTruthy();
    expect(scope.getAllByText("IDR 150,000").length).toBeGreaterThanOrEqual(2);
    expect(scope.getByText("Unpaid sessions")).toBeTruthy();
    expect(scope.getByText(/Arpeggios/)).toBeTruthy();
    expect(scope.getByText(/This is a draft/)).toBeTruthy();
  });

  it("the header shows the business profile and never the owner's name", async () => {
    const { paid, unpaid, c, run } = await seedRun();
    const { container } = render(
      <Providers>
        <PaycheckDocument {...docProps(run, paid, unpaid, c)} />
      </Providers>,
    );
    const scope = within(container);
    expect(scope.getByText("Melody Studio")).toBeTruthy();
    expect(scope.getByText("Music lessons for every age")).toBeTruthy();
    expect(scope.getByText("Jl. Melati 12, Bandung")).toBeTruthy();
    expect(scope.getByText("081234567890")).toBeTruthy();
    expect(scope.queryByText("Rina Hartono")).toBeNull();
  });

  it("a paid run shows Paid, the paid date, and no Draft label or draft hint", async () => {
    const { s, paid, unpaid, c, run } = await seedRun();
    const paidRun = await s.payroll.setStatus(run.id, { status: "paid", idempotencyKey: createId() });
    expect(paidRun.status).toBe("paid");
    const { container } = render(
      <Providers>
        <PaycheckDocument {...docProps(paidRun, paid, unpaid, c)} />
      </Providers>,
    );
    const scope = within(container);
    expect(scope.getByText("Paid", { exact: true })).toBeTruthy();
    expect(scope.queryByText("Draft", { exact: true })).toBeNull();
    expect(scope.queryByText(/This is a draft/)).toBeNull();
    expect(scope.getByText(/Paid on/)).toBeTruthy();
    expect(scope.getAllByText("IDR 150,000").length).toBeGreaterThanOrEqual(2);
  });

  it("a run with no paid sessions states that instead of an empty table", async () => {
    const { run, c } = await seedRun();
    const empty: PayrollRun = { ...run, sessionIds: [], sessionCount: 0, total: 0 };
    const { container } = render(
      <Providers>
        <PaycheckDocument run={empty} trainerName="Budi" paidSessions={[]} unpaidSessions={[]} courseById={new Map([[c.id, c]])} profile={profile} />
      </Providers>,
    );
    const scope = within(container);
    expect(scope.getByText("No paid sessions in this period.")).toBeTruthy();
    expect(scope.getByText("IDR 0")).toBeTruthy();
  });

  it("uses a viewport-friendly width for the preview", async () => {
    const { paid, unpaid, c, run } = await seedRun();
    const { container } = render(
      <Providers>
        <PaycheckDocument {...docProps(run, paid, unpaid, c)} />
      </Providers>,
    );
    const document = container.querySelector<HTMLElement>('[data-testid="paycheck-document"]');
    expect(document?.style.width).toBe("min(640px, 100%)");
    expect(document?.style.maxWidth).toBe("640px");
  });
});

describe("PayrollScreen print paycheck", () => {
  /** Opens the run review and returns the open print button. */
  async function openReview() {
    render(
      <Providers>
        <PayrollScreen navigate={() => {}} />
      </Providers>,
    );
    const row = await screen.findByText("Budi", {}, { timeout: 3000 });
    fireEvent.click(row.closest("tr") ?? row);
    await screen.findByText("Review pay run", {}, { timeout: 3000 });
    return screen.getByRole("button", { name: "Print paycheck" });
  }

  it("a draft run offers Print paycheck and the preview shows Draft", async () => {
    stubRadix();
    await seedRun();
    const printButton = await openReview();
    fireEvent.click(printButton);
    const doc = await screen.findByTestId("paycheck-document", {}, { timeout: 3000 });
    expect(within(doc).getByText("Draft")).toBeTruthy();
    expect(within(doc).getByText("Budi")).toBeTruthy();
    expect(within(doc).getByText("Scales")).toBeTruthy();
  });

  it("a paid run offers Print paycheck and the preview shows Paid", async () => {
    stubRadix();
    const { s, run } = await seedRun();
    await s.payroll.setStatus(run.id, { status: "paid", idempotencyKey: createId() });
    const printButton = await openReview();
    fireEvent.click(printButton);
    const doc = await screen.findByTestId("paycheck-document", {}, { timeout: 3000 });
    expect(within(doc).getByText("Paid", { exact: true })).toBeTruthy();
    expect(within(doc).queryByText("Draft", { exact: true })).toBeNull();
  });
});
