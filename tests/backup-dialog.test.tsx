// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BackupDialog } from "@/components/backup/BackupDialog";
import { resetStorage } from "@/lib/storage";
import { Providers } from "./support";

const VALID_PASS = "BackupPass123";

function renderDialog() {
  render(
    <Providers>
      <BackupDialog open onOpenChange={() => {}} onRestored={async () => {}} onHelp={() => {}} />
    </Providers>,
  );
}

async function openRestoreTab() {
  fireEvent.click(screen.getByRole("tab", { name: "Restore" }));
  expect(await screen.findByLabelText("Backup passphrase")).toBeTruthy();
}

describe("Backup dialog", () => {
  beforeEach(async () => {
    await resetStorage();
    vi.stubGlobal("URL", { ...URL, createObjectURL: () => "blob:test", revokeObjectURL: () => {} });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("creation rejects a passphrase with symbols", async () => {
    renderDialog();
    expect(await screen.findByRole("heading", { name: "Backup and restore" })).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Encrypt this backup with a passphrase"));
    fireEvent.change(screen.getByLabelText("Passphrase"), { target: { value: "bad!pass1" } });
    fireEvent.change(screen.getByLabelText("Confirm passphrase"), { target: { value: "bad!pass1" } });
    fireEvent.click(screen.getByRole("button", { name: "Create backup" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe("Passphrase must use letters and numbers only.");
    expect(screen.queryByText("Backup saved")).toBeNull();
  });

  it("creation rejects a passphrase with whitespace", async () => {
    renderDialog();
    expect(await screen.findByRole("heading", { name: "Backup and restore" })).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Encrypt this backup with a passphrase"));
    fireEvent.change(screen.getByLabelText("Passphrase"), { target: { value: "bad pass1" } });
    fireEvent.change(screen.getByLabelText("Confirm passphrase"), { target: { value: "bad pass1" } });
    fireEvent.click(screen.getByRole("button", { name: "Create backup" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe("Passphrase must use letters and numbers only.");
    expect(screen.queryByText("Backup saved")).toBeNull();
  });

  it("creation accepts a plain alphanumeric passphrase", async () => {
    renderDialog();
    expect(await screen.findByRole("heading", { name: "Backup and restore" })).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Encrypt this backup with a passphrase"));
    fireEvent.change(screen.getByLabelText("Passphrase"), { target: { value: VALID_PASS } });
    fireEvent.change(screen.getByLabelText("Confirm passphrase"), { target: { value: VALID_PASS } });
    fireEvent.click(screen.getByRole("button", { name: "Create backup" }));
    expect(await screen.findByText("Backup saved", {}, { timeout: 10000 })).toBeTruthy();
  });

  it("restore entry rejects a passphrase with symbols", async () => {
    renderDialog();
    expect(await screen.findByRole("heading", { name: "Backup and restore" })).toBeTruthy();
    await openRestoreTab();
    fireEvent.change(screen.getByLabelText("Backup passphrase"), { target: { value: "bad!pass1" } });
    fireEvent.change(screen.getByLabelText("Drop a backup here or choose a file"), {
      target: { files: [new File(["not-a-backup"], "backup.zip", { type: "application/zip" })] },
    });
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe("Backup passphrase must use letters and numbers only.");
    expect(screen.queryByText("Review before restoring")).toBeNull();
  });

  it("restore entry rejects a passphrase with whitespace", async () => {
    renderDialog();
    expect(await screen.findByRole("heading", { name: "Backup and restore" })).toBeTruthy();
    await openRestoreTab();
    fireEvent.change(screen.getByLabelText("Backup passphrase"), { target: { value: "bad pass1" } });
    fireEvent.change(screen.getByLabelText("Drop a backup here or choose a file"), {
      target: { files: [new File(["not-a-backup"], "backup.zip", { type: "application/zip" })] },
    });
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe("Backup passphrase must use letters and numbers only.");
    expect(screen.queryByText("Review before restoring")).toBeNull();
  });
});
