// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { TrashScreen } from "@/components/screens/TrashScreen";
import { getServices, resetServices } from "@/lib/domain/services";
import { resetStorage } from "@/lib/storage";
import { createId } from "@/lib/storage/utils";
import { Providers } from "./support";

describe("TrashScreen", () => {
  beforeEach(async () => {
    await resetStorage();
    resetServices();
  });

  afterEach(async () => {
    await resetStorage();
    resetServices();
  });

  it("opens a trashed record's snapshot details", async () => {
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

    render(
      <Providers>
        <TrashScreen navigate={() => {}} />
      </Providers>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "View details" }));

    expect(await screen.findByText("Prefers evening classes")).toBeTruthy();
    expect(screen.getByText("Notes")).toBeTruthy();
  });
});
