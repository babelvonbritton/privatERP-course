// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { getServices, resetServices, applyBusinessProfile, Services } from "@/lib/domain/services";
import { ORG_ID, OWNER_ID, type Invoice } from "@/lib/domain/types";
import { getStorage, resetStorage } from "@/lib/storage";
import { DEFAULT_BUSINESS_PROFILE, actorForProfile, type BusinessProfile } from "@/lib/storage/BusinessProfileService";
import { createId } from "@/lib/storage/utils";
import { DashboardScreen } from "@/components/screens/DashboardScreen";
import { SettingsScreen } from "@/components/screens/SettingsScreen";
import { TourProvider, TOUR_STEPS } from "@/components/Tour";
import { InvoiceDocument } from "@/components/invoices/InvoiceDocument";
import { Providers } from "./support";

// This repo has no global testing-library cleanup: unmount each render
// between tests, or a stale tree from the previous test stays in the document.
afterEach(() => cleanup());

async function freshServices() {
  await resetStorage();
  resetServices();
  return getServices();
}

const memberInput = (name: string) => ({
  name,
  email: `${name.toLowerCase()}@example.com`,
  phone: "0812000000",
  notes: "",
  status: "active" as const,
  idempotencyKey: createId(),
});

function invoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: createId(),
    orgId: "org-owner",
    ownerId: "owner",
    createdAt: new Date("2026-11-20T00:00:00").getTime(),
    updatedAt: new Date("2026-11-20T00:00:00").getTime(),
    rev: 1,
    number: "INV-20261120-001",
    memberId: "member-1",
    enrollmentId: null,
    lineItems: [{ description: "Course fee", amount: 500000 }],
    total: 500000,
    paidAmount: 0,
    dueDate: "2026-12-01",
    status: "sent",
    paymentMethod: "cash",
    paymentDetails: "",
    ...overrides,
  };
}

const PROFILE: BusinessProfile = {
  businessName: "Melody Studio",
  ownerName: "Ayu Lestari",
  address: "Jl. Melati 12, Bandung",
  contacts: ["081234567890", "hello@melody.example"],
  tagline: "Music lessons for every age",
  logoAttachmentId: null,
};

describe("business profile storage", () => {
  it("loads empty defaults, saves a full profile, and reads it back", async () => {
    await freshServices();
    const storage = getStorage();
    expect((await storage.profile.load()).profile).toEqual(DEFAULT_BUSINESS_PROFILE);
    const saved = await storage.profile.save(PROFILE);
    expect(saved).toEqual(PROFILE);
    expect((await storage.profile.load()).profile).toEqual(PROFILE);
    expect((await storage.profile.load()).profile.contacts).toEqual(["081234567890", "hello@melody.example"]);
  });

  it("repairs a damaged contacts value instead of failing the load", async () => {
    await freshServices();
    const storage = getStorage();
    await storage.settings.write("profile.contacts", "not json at all");
    await storage.settings.write("profile.businessName", "Melody Studio");
    const { profile, repaired } = await storage.profile.load();
    expect(profile.contacts).toEqual([]);
    expect(profile.businessName).toBe("Melody Studio");
    expect(repaired).toContain("profile.contacts");
  });

  it("rejects a business name past the length limit", async () => {
    await freshServices();
    await expect(getStorage().profile.save({ ...PROFILE, businessName: "x".repeat(81) })).rejects.toThrow();
  });

  it("derives the actor from the profile, with the constants as fallback", () => {
    expect(actorForProfile(PROFILE)).toEqual({ id: "Ayu Lestari", orgId: "Melody Studio", role: "owner" });
    expect(actorForProfile(DEFAULT_BUSINESS_PROFILE)).toEqual({ id: OWNER_ID, orgId: ORG_ID, role: "owner" });
    expect(actorForProfile({ ...PROFILE, businessName: "  ", ownerName: "" })).toEqual({ id: OWNER_ID, orgId: ORG_ID, role: "owner" });
  });
});

describe("profile-derived record ids", () => {
  it("stamps new records with the profile names, and old records keep theirs", async () => {
    const s = await freshServices();
    const before = await s.members.create(memberInput("Ana"));
    expect(before.orgId).toBe(ORG_ID);
    expect(before.ownerId).toBe(OWNER_ID);

    applyBusinessProfile(PROFILE);
    const after = await s.members.create(memberInput("Benny"));
    expect(after.orgId).toBe("Melody Studio");
    expect(after.ownerId).toBe("Ayu Lestari");

    // The earlier record is untouched: no migration rewrites stamped values.
    const storedBefore = await s.members.get(before.id);
    expect(storedBefore?.orgId).toBe(ORG_ID);
    expect(storedBefore?.ownerId).toBe(OWNER_ID);

    // Audit entries follow the same actor as the record they describe.
    const entries = await getStorage().audit.listRecent(10);
    const createEntry = entries.find((e) => e.action === "member.create" && e.entityId === after.id);
    expect(createEntry?.orgId).toBe("Melody Studio");
    expect(createEntry?.actorId).toBe("Ayu Lestari");
  });

  it("falls back to the constants when the profile is cleared", async () => {
    const s = await freshServices();
    applyBusinessProfile(PROFILE);
    applyBusinessProfile(DEFAULT_BUSINESS_PROFILE);
    const member = await s.members.create(memberInput("Citra"));
    expect(member.orgId).toBe(ORG_ID);
    expect(member.ownerId).toBe(OWNER_ID);
  });

  it("a Services built directly with an explicit actor keeps that actor", async () => {
    await freshServices();
    const direct = new Services(getStorage(), { id: "custom-owner", orgId: "Custom Org", role: "owner" });
    const member = await direct.members.create(memberInput("Dewi"));
    expect(member.orgId).toBe("Custom Org");
    expect(member.ownerId).toBe("custom-owner");
    // Applying a profile to the shared services does not touch the direct one.
    applyBusinessProfile(PROFILE);
    const second = await direct.members.create(memberInput("Eko"));
    expect(second.orgId).toBe("Custom Org");
  });
});

describe("dashboard reminder and quick setup", () => {
  it("shows the reminder while the business name is empty, and saving a name clears it in place", async () => {
    await freshServices();
    const navigate = vi.fn();
    const { container } = render(
      <Providers>
        <DashboardScreen navigate={navigate} />
      </Providers>,
    );
    const scope = within(container);
    await scope.findByText("Set up your business profile");
    expect(scope.getByRole("button", { name: "Quick setup" })).toBeTruthy();

    fireEvent.click(scope.getByRole("button", { name: "Quick setup" }));
    // The form opens as a modal on the dashboard: no navigation happened.
    expect(navigate).not.toHaveBeenCalled();
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("Business profile");

    // The Save button stays disabled until the stored profile loads.
    await waitFor(() => expect((within(dialog).getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled).toBe(false));

    // Saving without a name shows the error and stays in the dialog.
    fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
    await within(dialog).findByText("Enter a business name to save the profile.");
    expect(screen.queryByRole("dialog")).not.toBeNull();

    fireEvent.change(within(dialog).getByLabelText("Business name", { exact: true }), { target: { value: "Melody Studio" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(scope.queryByText("Set up your business profile")).toBeNull();
    expect((await getStorage().profile.load()).profile.businessName).toBe("Melody Studio");
    expect(navigate).not.toHaveBeenCalled();
  });

  it("does not show the reminder once a business name is saved", async () => {
    await freshServices();
    await getStorage().profile.save(PROFILE);
    const { container } = render(
      <Providers>
        <DashboardScreen navigate={() => {}} />
      </Providers>,
    );
    await within(container).findByText("Dashboard");
    // The reminder renders until the stored profile loads, then clears.
    await waitFor(() => expect(within(container).queryByText("Set up your business profile")).toBeNull());
  });
});

describe("settings business profile section", () => {
  it("sits at the top of Settings and edits the profile", async () => {
    await freshServices();
    await getStorage().preferences.set("tourSeen", true);
    const { container } = render(
      <Providers>
        <TourProvider navigate={() => {}}>
          <SettingsScreen navigate={() => {}} />
        </TourProvider>
      </Providers>,
    );
    const scope = within(container);
    await scope.findByRole("heading", { name: "Business profile" });
    // The profile section comes before the Language section.
    const headings = [...container.querySelectorAll("h2")].map((h) => h.textContent);
    expect(headings[0]).toBe("Business profile");
    expect(headings).toContain("Language");

    fireEvent.change(scope.getByLabelText("Business name", { exact: true }), { target: { value: "Melody Studio" } });
    fireEvent.change(scope.getByLabelText("Owner's name", { exact: true }), { target: { value: "Ayu Lestari" } });
    fireEvent.change(scope.getByLabelText("Business tagline", { exact: true }), { target: { value: "Music lessons for every age" } });
    // Contacts are a tag list: type one and confirm it with Enter.
    fireEvent.change(scope.getByLabelText("Business contacts", { exact: true }), { target: { value: "081234567890" } });
    fireEvent.keyDown(scope.getByLabelText("Business contacts", { exact: true }), { key: "Enter" });
    fireEvent.click(scope.getByRole("button", { name: "Save changes" }));
    await waitFor(async () => {
      expect((await getStorage().profile.load()).profile).toMatchObject({
        businessName: "Melody Studio",
        ownerName: "Ayu Lestari",
        tagline: "Music lessons for every age",
        contacts: ["081234567890"],
      });
    });
  });
});

describe("invoice shows the profile", () => {
  it("shows logo, name, tagline, address, and contacts, but never the owner's name", async () => {
    const logoBlob = new Blob(["fake-png-bytes"], { type: "image/png" });
    const { container } = render(
      <Providers>
        <InvoiceDocument invoice={invoice()} memberName="Ana" profile={PROFILE} logoBlob={logoBlob} />
      </Providers>,
    );
    await waitFor(() => expect(container.querySelector('img[src^="data:"]')).not.toBeNull());
    expect(container.textContent).toContain("Melody Studio");
    expect(container.textContent).toContain("Music lessons for every age");
    expect(container.textContent).toContain("Jl. Melati 12, Bandung");
    expect(container.textContent).toContain("081234567890");
    expect(container.textContent).toContain("hello@melody.example");
    expect(container.textContent).not.toContain("Ayu Lestari");
  });

  it("falls back to the Olaseena wordmark with an empty profile", () => {
    const { container } = render(
      <Providers>
        <InvoiceDocument invoice={invoice()} memberName="Ana" />
      </Providers>,
    );
    expect(container.textContent).toContain("Olaseena");
    expect(container.textContent).not.toContain("Music lessons");
    expect(container.querySelector("img")).toBeNull();
  });

  it("omits empty optional fields", () => {
    const { container } = render(
      <Providers>
        <InvoiceDocument invoice={invoice()} memberName="Ana" profile={{ ...PROFILE, address: "", contacts: [], tagline: "" }} />
      </Providers>,
    );
    expect(container.textContent).toContain("Melody Studio");
    expect(container.textContent).not.toContain("Jl. Melati");
  });
});

describe("tour profile step", () => {
  it("has a profile step after the settings intro and before Drive, targeting the top of the Settings section", async () => {
    // The profile section sits at the top of Settings, so the tour visits
    // it right after the intro and before the Drive section below it.
    expect(TOUR_STEPS[TOUR_STEPS.length - 2]).toEqual({ nav: "settings", target: "profile", step: "profile" });
    expect(TOUR_STEPS[TOUR_STEPS.length - 1]).toEqual({ nav: "settings", target: "drive", step: "drive" });
    await freshServices();
    const { container } = render(
      <Providers>
        <TourProvider navigate={() => {}}>
          <div data-tour="dashboard">
            <h1>Dashboard</h1>
          </div>
          <div data-tour="profile">
            <h1>Business profile</h1>
          </div>
        </TourProvider>
      </Providers>,
    );
    const scope = within(container);
    await scope.findByRole("dialog", {}, { timeout: 3000 });
    for (let i = 0; i < 10; i++) {
      fireEvent.click(scope.getByRole("button", { name: "Next" }));
    }
    const dialog = await scope.findByRole("dialog", {}, { timeout: 3000 });
    expect(dialog.textContent).toContain("Business profile");
  });
});
