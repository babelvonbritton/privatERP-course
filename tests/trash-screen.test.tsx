// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TrashScreen } from "@/components/screens/TrashScreen";
import { getServices, resetServices } from "@/lib/domain/services";
import { getStorage, resetStorage } from "@/lib/storage";
import type { BusinessProfile } from "@/lib/storage/BusinessProfileService";
import { createId } from "@/lib/storage/utils";
import { Providers } from "./support";

const PROFILE: BusinessProfile = {
  businessName: "Melody Studio",
  ownerName: "Ayu Lestari",
  address: "Jl. Melati 12, Bandung",
  contacts: ["081234567890"],
  tagline: "Music lessons for every age",
  logoAttachmentId: null,
};

async function trashAMember() {
  const services = getServices();
  const member = await services.members.create({
    name: "Ana",
    email: "ana@example.com",
    phone: "0812000000",
    notes: "Prefers evening classes",
    status: "active",
    idempotencyKey: createId(),
  });
  await services.members.remove(member.id);
  return member;
}

async function openDetails() {
  render(
    <Providers>
      <TrashScreen navigate={() => {}} />
    </Providers>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "View details" }));
}

describe("TrashScreen", () => {
  beforeEach(async () => {
    await resetStorage();
    resetServices();
  });

  afterEach(async () => {
    cleanup();
    await resetStorage();
    resetServices();
  });

  it("opens a trashed record's snapshot details", async () => {
    await trashAMember();

    await openDetails();

    expect(await screen.findByText("Prefers evening classes")).toBeTruthy();
    expect(screen.getByText("Notes")).toBeTruthy();
  });

  it("a trash item created before the profile was set shows the profile's names in its detail", async () => {
    await trashAMember();
    // The member was stamped with the placeholder ids at creation; the
    // profile is only set afterwards.
    await getStorage().profile.save(PROFILE);

    await openDetails();

    expect(await screen.findByText("Melody Studio")).toBeTruthy();
    expect(screen.getByText("Ayu Lestari")).toBeTruthy();
    expect(screen.getByText("Organization ID")).toBeTruthy();
    expect(screen.getByText("Owner ID")).toBeTruthy();
    // The stored entry keeps its stamped ids: this is a display fix,
    // not a backfill.
    const entries = await getServices().trash.list();
    expect(entries).toHaveLength(1);
    expect((entries[0].snapshot as { orgId: string }).orgId).toBe("Olaseena");
    expect((entries[0].snapshot as { ownerId: string }).ownerId).toBe("owner");
  });

  it("with no profile set the detail falls back to the snapshot's ids", async () => {
    await trashAMember();

    await openDetails();

    expect(await screen.findByText("Olaseena")).toBeTruthy();
    expect(screen.getByText("owner")).toBeTruthy();
  });
});
