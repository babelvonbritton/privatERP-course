// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { TrainersScreen } from "@/components/screens/TrainersScreen";
import { getServices, resetServices } from "@/lib/domain/services";
import { resetCurrency, setCurrency } from "@/lib/currency";
import { getStorage, resetStorage } from "@/lib/storage";
import { createId } from "@/lib/storage/utils";
import { Providers } from "./support";

async function freshServices() {
  await resetStorage();
  resetServices();
  resetCurrency();
  return getServices();
}

async function seedTrainer() {
  const s = await freshServices();
  await s.trainers.create({ name: "Budi", email: "budi@example.com", phone: "0812000001", subjects: ["Piano"], ratePerSession: 150000, status: "active", idempotencyKey: createId() });
}

describe("currency labels follow the setting", () => {
  beforeEach(async () => {
    await freshServices();
  });

  afterEach(async () => {
    await resetStorage();
    resetServices();
    resetCurrency();
  });

  it("the trainer rate label shows the active currency in the table and the form, and follows a switch", async () => {
    await seedTrainer();

    render(
      <Providers>
        <TrainersScreen navigate={() => {}} />
      </Providers>,
    );

    expect(await screen.findByText("Rate per session (IDR)")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add trainer" }));
    expect(await screen.findByLabelText("Rate per session (IDR)")).toBeTruthy();

    act(() => setCurrency("EUR"));
    expect((await screen.findAllByText("Rate per session (EUR)")).length).toBe(2);
    expect(await screen.findByLabelText("Rate per session (EUR)")).toBeTruthy();
    expect(screen.queryByText("Rate per session (IDR)")).toBeNull();
  });

  it("the trainer rate label follows the setting in Indonesian too", async () => {
    await seedTrainer();
    act(() => setCurrency("USD"));

    render(
      <Providers locale="id">
        <TrainersScreen navigate={() => {}} />
      </Providers>,
    );

    expect(await screen.findByText("Tarif per sesi (USD)")).toBeTruthy();
  });
});
