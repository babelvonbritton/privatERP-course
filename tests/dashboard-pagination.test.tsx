// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { todayIso } from "@/lib/dates";
import { getServices, resetServices, today } from "@/lib/domain/services";
import { resetStorage } from "@/lib/storage";
import { createId } from "@/lib/storage/utils";
import { DashboardScreen } from "@/components/screens/DashboardScreen";
import { Providers } from "./support";

afterEach(() => cleanup());

async function freshServices() {
  await resetStorage();
  resetServices();
  return getServices();
}

const trainer = (name: string) => ({
  name,
  email: `${name.toLowerCase()}@example.com`,
  phone: "0812000001",
  subjects: ["Piano"],
  ratePerSession: 100000,
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

/** The next `count` Mon/Wed/Fri dates from today, in order. */
function upcomingSlotDates(count: number): string[] {
  const out: string[] = [];
  const d = new Date();
  while (out.length < count) {
    const day = d.getDay();
    if (day === 1 || day === 3 || day === 5) out.push(todayIso(d));
    d.setDate(d.getDate() + 1);
  }
  return out;
}

/** One trainer, one Mon/Wed/Fri course, 7 upcoming sessions, 4 invoices. */
async function seed() {
  const s = await freshServices();
  const t = await s.trainers.create(trainer("Budi"));
  const course = await s.courses.create({
    title: "Piano",
    description: "",
    level: "Beginner",
    price: 100000,
    requiredSkills: [],
    scheduleWeekdays: [1, 3, 5],
    status: "active",
    idempotencyKey: createId(),
  });
  const m = await s.members.create(member("Ana"));
  const dates = upcomingSlotDates(7);
  for (const [i, date] of dates.entries()) {
    await s.attendance.createSession({
      courseId: course.id,
      date,
      topic: `Topic ${i + 1}`,
      trainerId: t.id,
      trainerPresent: false,
      startTime: "09:00",
      endTime: "10:00",
      idempotencyKey: createId(),
    });
  }
  const invoices = [];
  for (let i = 1; i <= 4; i++) {
    invoices.push(
      await s.invoices.create({
        memberId: m.id,
        enrollmentId: null,
        lineItems: [{ description: `Fee ${i}`, amount: 100000 * i }],
        dueDate: "2026-12-01",
        status: "sent",
        paymentMethod: "cash",
        paymentDetails: "",
        idempotencyKey: createId(),
      }),
    );
    await new Promise((r) => setTimeout(r, 2));
  }
  return { s, t, course, m, dates, invoices };
}

describe("dashboard pagination and latest-three invoices", () => {
  it("dashboard.get returns every upcoming session and only the latest 3 invoices", async () => {
    const { s, dates, invoices } = await seed();
    const data = await s.dashboard.get(today());
    expect(data.upcomingSessions).toHaveLength(7);
    expect(data.upcomingSessions.map((x) => x.date)).toEqual(dates);
    expect(data.recentInvoices).toHaveLength(3);
    expect(data.recentInvoices.map((x) => x.number)).toEqual([
      invoices[3].number,
      invoices[2].number,
      invoices[1].number,
    ]);
  });

  it("upcoming sessions paginate 5 per page and the controls navigate", async () => {
    await seed();
    render(
      <Providers>
        <DashboardScreen navigate={() => {}} />
      </Providers>,
    );
    await screen.findByText("Topic 1");
    for (let i = 1; i <= 5; i++) expect(screen.getByText(`Topic ${i}`)).toBeTruthy();
    expect(screen.queryByText("Topic 6")).toBeNull();
    expect(screen.queryByText("Topic 7")).toBeNull();
    expect(screen.getByText("Page 1 of 2")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("Page 2 of 2")).toBeTruthy();
    expect(screen.getByText("Topic 6")).toBeTruthy();
    expect(screen.getByText("Topic 7")).toBeTruthy();
    expect(screen.queryByText("Topic 1")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect(screen.getByText("Page 1 of 2")).toBeTruthy();
    expect(screen.getByText("Topic 1")).toBeTruthy();
  });

  it("shows exactly the latest 3 invoices and View all navigates to the invoice menu", async () => {
    const { invoices } = await seed();
    const onNavigate = vi.fn();
    render(
      <Providers>
        <DashboardScreen navigate={onNavigate} />
      </Providers>,
    );
    await screen.findByText("Topic 1");
    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("row")).toHaveLength(4);
    expect(screen.getByText(invoices[3].number)).toBeTruthy();
    expect(screen.getByText(invoices[2].number)).toBeTruthy();
    expect(screen.getByText(invoices[1].number)).toBeTruthy();
    expect(screen.queryByText(invoices[0].number)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "View all" }));
    expect(onNavigate).toHaveBeenCalledWith("invoices");
  });

  it("starts on page 1 again when the dashboard is revisited with a changed list", async () => {
    const { s, course, t } = await seed();
    const { unmount } = render(
      <Providers>
        <DashboardScreen navigate={() => {}} />
      </Providers>,
    );
    await screen.findByText("Topic 1");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("Page 2 of 2")).toBeTruthy();
    unmount();
    const dates = upcomingSlotDates(8);
    await s.attendance.createSession({
      courseId: course.id,
      date: dates[7],
      topic: "Topic 8",
      trainerId: t.id,
      trainerPresent: false,
      startTime: "09:00",
      endTime: "10:00",
      idempotencyKey: createId(),
    });
    render(
      <Providers>
        <DashboardScreen navigate={() => {}} />
      </Providers>,
    );
    await screen.findByText("Topic 1");
    expect(screen.getByText("Page 1 of 2")).toBeTruthy();
    expect(screen.getByText("Topic 5")).toBeTruthy();
    expect(screen.queryByText("Topic 8")).toBeNull();
  });
});
