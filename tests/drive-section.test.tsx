// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DriveSection } from "@/components/settings/DriveSection";
import { DriveService, readDriveState, writeDriveState } from "@/lib/drive";
import { resetDriveSyncManager } from "@/lib/driveSync";
import { getStorage, resetStorage } from "@/lib/storage";
import { Providers } from "./support";

const VALID_PASS = "SyncPass123";

async function renderConnected(passphrase?: string) {
  const storage = getStorage();
  await writeDriveState(storage.settings, {
    accessToken: "tok",
    tokenExpiresAt: Date.now() + 3600_000,
    ...(passphrase ? { passphrase } : {}),
  });
  render(
    <Providers>
      <DriveSection onRestored={async () => {}} />
    </Providers>,
  );
  expect(await screen.findByText("Connected")).toBeTruthy();
}

function toggle() {
  return screen.getByRole("switch", { name: /Auto-sync to Drive/ });
}

function dialog() {
  return screen.getByRole("dialog");
}

async function openSetupDialog() {
  fireEvent.click(toggle());
  expect(await screen.findByRole("heading", { name: "Set up auto-sync" })).toBeTruthy();
  return dialog();
}

describe("Drive section", () => {
  beforeEach(async () => {
    await resetStorage();
    resetDriveSyncManager();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
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
    const syncToggle = toggle();
    expect(syncToggle.getAttribute("aria-checked")).toBe("false");
    expect((syncToggle as HTMLButtonElement).disabled).toBe(true);
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
    expect((toggle() as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText("Back up to Drive once first, so the passphrase is saved on this device for auto-sync.")).toBeNull();
  });

  it("turning sync on with no stored passphrase opens the setup dialog; Cancel turns it back off and stores nothing", async () => {
    await renderConnected();
    const dlg = await openSetupDialog();
    expect(within(dlg).getByText(/Auto-sync needs a backup passphrase/)).toBeTruthy();
    fireEvent.click(within(dlg).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    const state = await readDriveState(getStorage().settings);
    expect(state.passphrase).toBeNull();
    expect(state.syncEnabled).toBe(false);
  });

  it("mismatched, symbol, and whitespace passphrases show the error and do not store or enable sync", async () => {
    await renderConnected();
    const dlg = await openSetupDialog();
    const pass = within(dlg).getByLabelText("Backup passphrase") as HTMLInputElement;
    const confirm = within(dlg).getByLabelText("Confirm backup passphrase") as HTMLInputElement;
    const confirmBtn = within(dlg).getByRole("button", { name: "Confirm" });

    fireEvent.change(pass, { target: { value: "good1234" } });
    fireEvent.change(confirm, { target: { value: "good1235" } });
    expect(within(dlg).getByRole("alert").textContent).toBe("The two passphrases do not match.");
    expect((confirmBtn as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(pass, { target: { value: "bad!pass" } });
    fireEvent.change(confirm, { target: { value: "bad!pass" } });
    expect(within(dlg).getByRole("alert").textContent).toBe("Backup passphrase must use letters and numbers only.");
    expect((confirmBtn as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(pass, { target: { value: "bad pass" } });
    fireEvent.change(confirm, { target: { value: "bad pass" } });
    expect(within(dlg).getByRole("alert").textContent).toBe("Backup passphrase must use letters and numbers only.");
    expect((confirmBtn as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(confirmBtn);
    expect(screen.queryByRole("heading", { name: "Save your passphrase" })).toBeNull();
    const state = await readDriveState(getStorage().settings);
    expect(state.passphrase).toBeNull();
    expect(state.syncEnabled).toBe(false);
  });

  it("a valid matching passphrase stores it, shows the download step, and leaves the toggle on", async () => {
    await renderConnected();
    const dlg = await openSetupDialog();
    fireEvent.change(within(dlg).getByLabelText("Backup passphrase"), { target: { value: VALID_PASS } });
    fireEvent.change(within(dlg).getByLabelText("Confirm backup passphrase"), { target: { value: VALID_PASS } });
    const confirmBtn = within(dlg).getByRole("button", { name: "Confirm" });
    expect((confirmBtn as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(confirmBtn);
    expect(await screen.findByRole("heading", { name: "Save your passphrase" })).toBeTruthy();
    expect(within(dialog()).getByRole("button", { name: "Download passphrase (JSON)" })).toBeTruthy();
    const state = await readDriveState(getStorage().settings);
    expect(state.passphrase).toBe(VALID_PASS);
    expect(state.syncEnabled).toBe(true);
    fireEvent.click(within(dialog()).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(toggle().getAttribute("aria-checked")).toBe("true");
  });

  it("turning sync on with a stored passphrase enables it immediately with no dialog", async () => {
    await renderConnected("ExistingPass1");
    fireEvent.click(toggle());
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(toggle().getAttribute("aria-checked")).toBe("true"));
    expect((await readDriveState(getStorage().settings)).syncEnabled).toBe(true);
  });

  it("show/hide toggles each setup field between password and text", async () => {
    await renderConnected();
    const dlg = await openSetupDialog();
    const pass = within(dlg).getByLabelText("Backup passphrase") as HTMLInputElement;
    expect(pass.type).toBe("password");
    const showButtons = within(dlg).getAllByRole("button", { name: "Show" });
    expect(showButtons).toHaveLength(2);
    fireEvent.click(showButtons[0]);
    expect(pass.type).toBe("text");
    fireEvent.click(within(dlg).getByRole("button", { name: "Hide" }));
    expect(pass.type).toBe("password");
  });

  it("Drive backup creation rejects a symbol or whitespace passphrase and uploads nothing", async () => {
    const listSpy = vi.spyOn(DriveService.prototype, "listBackups").mockResolvedValue([]);
    const uploadSpy = vi.spyOn(DriveService.prototype, "uploadBackup").mockResolvedValue({ id: "f1", modifiedTime: "2026-11-25T00:00:00.000Z" });
    await renderConnected();
    fireEvent.change(screen.getByLabelText("Backup passphrase"), { target: { value: "bad!pass1" } });
    fireEvent.change(screen.getByLabelText("Confirm backup passphrase"), { target: { value: "bad!pass1" } });
    fireEvent.click(screen.getByRole("button", { name: "Back up to Drive" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe("Backup passphrase must use letters and numbers only.");
    expect(listSpy).not.toHaveBeenCalled();
    expect(uploadSpy).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Backup passphrase"), { target: { value: "bad pass1" } });
    fireEvent.change(screen.getByLabelText("Confirm backup passphrase"), { target: { value: "bad pass1" } });
    fireEvent.click(screen.getByRole("button", { name: "Back up to Drive" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(listSpy).not.toHaveBeenCalled();
    expect(uploadSpy).not.toHaveBeenCalled();
  });

  it("Drive restore entry rejects a passphrase with symbols or whitespace", async () => {
    vi.spyOn(DriveService.prototype, "listBackups").mockResolvedValue([
      { id: "f1", name: "olaseena-backup.olaseena", modifiedTime: "2026-11-25T00:00:00.000Z", size: "10" },
    ]);
    const downloadSpy = vi.spyOn(DriveService.prototype, "downloadBackup").mockResolvedValue(new Uint8Array([1, 2, 3]));
    await renderConnected();
    fireEvent.change(screen.getByLabelText("Backup passphrase"), { target: { value: "bad!pass1" } });
    fireEvent.click(screen.getByRole("button", { name: "Restore from Drive" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe("Backup passphrase must use letters and numbers only.");
    expect(downloadSpy).toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.change(screen.getByLabelText("Backup passphrase"), { target: { value: "bad pass1" } });
    fireEvent.click(screen.getByRole("button", { name: "Restore from Drive" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe("Backup passphrase must use letters and numbers only.");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
