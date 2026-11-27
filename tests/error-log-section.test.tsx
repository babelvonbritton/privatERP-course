// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorLogSection } from "@/components/settings/ErrorLogSection";
import { FileSaver } from "@/lib/backup/FileSaver";
import { persistErrorLog } from "@/lib/errors/errorLog";
import { getStorage, resetStorage } from "@/lib/storage";
import { Providers } from "./support";

const NOW = Date.parse("2026-11-27T10:00:00.000Z");

async function seed(count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await persistErrorLog({
      time: new Date(NOW - i * 60_000).toISOString(),
      code: i === 0 ? "STORAGE_FAILED" : "UNEXPECTED",
      action: "invoice.list",
      message: "UNEXPECTED",
      details: `Failure number ${i + 1}`,
    });
  }
}

function renderSection() {
  render(
    <Providers>
      <ErrorLogSection />
    </Providers>,
  );
}

describe("error log section", () => {
  beforeEach(async () => {
    await resetStorage();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows the empty state and disabled actions with no errors", async () => {
    renderSection();
    expect(await screen.findByText("No errors in the last 7 days.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Export error log" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Clear log" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows the count and the newest entries", async () => {
    await seed(2);
    renderSection();
    expect(await screen.findByText("2 errors")).toBeTruthy();
    expect(screen.getByText("STORAGE_FAILED")).toBeTruthy();
    expect(screen.getByText("Failure number 1")).toBeTruthy();
    expect(screen.getByText("Failure number 2")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Export error log" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("exports the log as a dated ZIP", async () => {
    await seed(1);
    const download = vi.spyOn(FileSaver, "download").mockImplementation(() => {});
    renderSection();
    await screen.findByText("1 error");
    fireEvent.click(screen.getByRole("button", { name: "Export error log" }));
    await waitFor(() => expect(download).toHaveBeenCalledTimes(1));
    const [bytes, fileName] = download.mock.calls[0];
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(fileName).toMatch(/^olaseena-errors-\d{4}-\d{2}-\d{2}\.zip$/);
  });

  it("asks first, then clears the log", async () => {
    await seed(1);
    renderSection();
    await screen.findByText("1 error");
    fireEvent.click(screen.getByRole("button", { name: "Clear log" }));
    expect(await screen.findByRole("alertdialog", {}, { timeout: 3000 })).toBeTruthy();
    expect(screen.getByText("Clear the error log?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    await waitFor(async () => {
      expect(await getStorage().errorLog.count()).toBe(0);
    });
    expect(await screen.findByText("No errors in the last 7 days.")).toBeTruthy();
    expect(screen.getByText("0 errors")).toBeTruthy();
  });
});
