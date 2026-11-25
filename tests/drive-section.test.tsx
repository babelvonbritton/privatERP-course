// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DriveSection } from "@/components/settings/DriveSection";
import { writeDriveState } from "@/lib/drive";
import { getStorage, resetStorage } from "@/lib/storage";
import { Providers } from "./support";

describe("Drive section", () => {
  beforeEach(async () => {
    await resetStorage();
  });

  // The test runner does not auto-clean the DOM between tests, so unmount each render explicitly.
  afterEach(() => {
    cleanup();
  });

  it("renders with Drive actions disabled while signed out and the sync toggle off", async () => {
    render(
      <Providers>
        <DriveSection onRestored={async () => {}} />
      </Providers>,
    );
    expect(await screen.findByRole("heading", { name: "Google Drive" })).toBeTruthy();
    expect(await screen.findByText("Not connected")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Connect Google Drive" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "Back up to Drive" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Restore from Drive" }) as HTMLButtonElement).disabled).toBe(true);
    const toggle = screen.getByRole("switch", { name: /Auto-sync to Drive/ });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect((toggle as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Connect Google Drive to turn on auto-sync.")).toBeTruthy();
  });

  it("shows the stored last-backup date once connected", async () => {
    const storage = getStorage();
    await writeDriveState(storage.settings, {
      accessToken: "tok",
      tokenExpiresAt: Date.now() + 3600_000,
      lastBackupAt: new Date("2026-11-25T10:30:00").getTime(),
    });
    render(
      <Providers>
        <DriveSection onRestored={async () => {}} />
      </Providers>,
    );
    expect(await screen.findByText("Connected")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Back up to Drive" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "Restore from Drive" }) as HTMLButtonElement).disabled).toBe(false);
    // The sync toggle stays disabled until a Drive backup has stored the passphrase.
    const toggle = screen.getByRole("switch", { name: /Auto-sync to Drive/ });
    expect((toggle as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Back up to Drive once first, so the passphrase is saved on this device for auto-sync.")).toBeTruthy();
  });
});
