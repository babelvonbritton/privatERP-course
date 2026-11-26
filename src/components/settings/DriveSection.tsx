"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "@/i18n";
import { BackupService, type FileLike } from "@/lib/backup/BackupService";
import type { Decision, MergeResult } from "@/lib/backup/MergePlanner";
import type { RestorePlan, StepState } from "@/lib/backup/types";
import {
  DEFAULT_DRIVE_CLIENT_ID,
  DRIVE_BACKUP_FILENAME,
  DRIVE_PASSPHRASE_FILENAME,
  DriveService,
  buildDrivePassphraseFile,
  ensureDriveToken,
  readDriveState,
  resolveDriveClientId,
  setupPassphraseError,
  writeDriveState,
  type DriveState,
} from "@/lib/drive";
import { isAlphanumericPassphrase } from "@/lib/backup/BackupCrypto";
import { getDriveSyncManager, type SyncState } from "@/lib/driveSync";
import { AppError } from "@/lib/errors/AppError";
import { errorCenter } from "@/lib/errors/ErrorCenter";
import { getStorage } from "@/lib/storage";
import { ErrorPanel } from "../ErrorPanel";
import { Button } from "../ui/Button";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { Modal } from "../ui/Modal";
import { Switch } from "../ui/Switch";
import { RestoreReview } from "../backup/RestoreReview";
import { Stepper } from "../backup/Stepper";

interface Props {
  /** Reloads workspace state after a restore replaced the data. */
  onRestored: () => Promise<void>;
}

const formatDateTime = (ms: number, locale: string) =>
  new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(ms));

/** Google Drive backup section in Settings: connect, back up, restore, and auto-sync. The backup file lives in the app's hidden Drive folder and never shows on drive.google.com. The last-backup date below is the proof it is there. */
export function DriveSection({ onRestored }: Props) {
  const { t, locale } = useI18n();
  const service = useMemo(() => new BackupService(getStorage(), errorCenter, { minStepMs: process.env.NODE_ENV === "test" ? 0 : 260 }), []);
  const drive = useMemo(() => new DriveService(), []);
  const syncManager = useMemo(() => getDriveSyncManager(), []);
  const [state, setState] = useState<DriveState | null>(null);
  const [syncState, setSyncState] = useState<SyncState>(() => syncManager.getState());
  const [clientId, setClientId] = useState("");
  const [showOwnId, setShowOwnId] = useState(false);
  const [drivePass, setDrivePass] = useState("");
  const [drivePassConfirm, setDrivePassConfirm] = useState("");
  // Passphrase setup dialog, shown when auto-sync is turned on before any
  // Drive passphrase is stored. Its fields live apart from the section's own
  // passphrase fields, so the dialog never disturbs a manual backup.
  const [setupOpen, setSetupOpen] = useState(false);
  const [setupStep, setSetupStep] = useState<"form" | "download">("form");
  const [setupPass, setSetupPass] = useState("");
  const [setupPassConfirm, setSetupPassConfirm] = useState("");
  const [showSetupPass, setShowSetupPass] = useState(false);
  const [showSetupPassConfirm, setShowSetupPassConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [steps, setSteps] = useState<StepState[]>([]);
  const [status, setStatus] = useState("");
  const [formError, setFormError] = useState("");
  const [error, setError] = useState<AppError | null>(null);
  // Bytes fetched by phase 1 of a restore, held until the passphrase is
  // entered and phase 2 inspects them. Cleared once phase 2 runs, so a
  // later restore always fetches fresh from Drive.
  const [heldBytes, setHeldBytes] = useState<Uint8Array | null>(null);
  const [plan, setPlan] = useState<RestorePlan | null>(null);
  const [decisions, setDecisions] = useState<Map<string, Decision>>(new Map());
  const [safety, setSafety] = useState(true);
  const [confirm, setConfirm] = useState(false);
  const [applySteps, setApplySteps] = useState<StepState[]>([]);
  const [applyError, setApplyError] = useState<AppError | null>(null);
  const [applyResult, setApplyResult] = useState<MergeResult | null>(null);

  const connected = !!state?.accessToken;
  const hasDefault = DEFAULT_DRIVE_CLIENT_ID.trim().length > 0;

  /** Live validation of the setup dialog fields; shown once the user has started typing, so the disabled Confirm explains itself. */
  const setupErrorKind = setupPassphraseError(setupPass, setupPassConfirm);
  const setupError =
    (setupPass !== "" || setupPassConfirm !== "") && setupErrorKind !== null
      ? setupErrorKind === "required"
        ? t("validation.required", { field: t("drive.passphrase") })
        : setupErrorKind === "alphanumeric"
          ? t("validation.alphanumeric", { field: t("drive.passphrase") })
          : t("drive.passphraseMismatch")
      : "";
  const setupValid = setupErrorKind === null;

  const reloadState = useCallback(async () => {
    try {
      setState(await readDriveState(getStorage().settings));
    } catch (e) {
      errorCenter.report(e, { action: "drive.state", surface: "inline" });
    }
  }, []);

  useEffect(() => {
    void reloadState();
    return syncManager.subscribe(setSyncState);
  }, [reloadState, syncManager]);

  // A dead session shows as disconnected from here on, so the next action
  // asks the user to connect again instead of failing the same way.
  const clearDeadSession = useCallback(async () => {
    await writeDriveState(getStorage().settings, { accessToken: null, tokenExpiresAt: null });
    await reloadState();
  }, [reloadState]);

  const fail = useCallback(
    async (e: unknown) => {
      const err = AppError.from(e);
      if (err.code === "DRIVE_AUTH") await clearDeadSession();
      setError(err);
      setStatus("");
    },
    [clearDeadSession],
  );

  /** A usable access token, refreshing silently when the stored one expired. Null when signed out or the grant is gone. */
  const getToken = useCallback(async (): Promise<string | null> => {
    const current = await readDriveState(getStorage().settings);
    return ensureDriveToken(drive, current, async (token) => {
      await writeDriveState(getStorage().settings, { accessToken: token.accessToken, tokenExpiresAt: token.expiresAt });
      await reloadState();
    });
  }, [drive, reloadState]);

  const runFlow = useCallback(
    async (job: () => Promise<void>) => {
      setBusy(true);
      setError(null);
      setFormError("");
      setStatus("");
      setSteps([]);
      try {
        await job();
      } catch (e) {
        await fail(e);
      } finally {
        setBusy(false);
      }
    },
    [fail],
  );

  const validPassphrase = useCallback((): string | null => {
    if (drivePass === "") {
      setFormError(t("validation.required", { field: t("drive.passphrase") }));
      return null;
    }
    if (!isAlphanumericPassphrase(drivePass)) {
      setFormError(t("validation.alphanumeric", { field: t("drive.passphrase") }));
      return null;
    }
    if (drivePass !== drivePassConfirm) {
      setFormError(t("drive.passphraseMismatch"));
      return null;
    }
    return drivePass;
  }, [drivePass, drivePassConfirm, t]);

  async function connect() {
    const id = clientId.trim() || DEFAULT_DRIVE_CLIENT_ID.trim();
    if (!id) {
      setError(new AppError("VALIDATION", { details: t("drive.noClientId") }));
      return;
    }
    await runFlow(async () => {
      const token = await drive.connect(id);
      await writeDriveState(getStorage().settings, {
        clientId: clientId.trim() ? clientId.trim() : null,
        accessToken: token.accessToken,
        tokenExpiresAt: token.expiresAt,
      });
      await reloadState();
    });
  }

  async function disconnect() {
    await runFlow(async () => {
      await writeDriveState(getStorage().settings, { accessToken: null, tokenExpiresAt: null });
      await reloadState();
    });
  }

  async function backup() {
    const passphrase = validPassphrase();
    if (!passphrase) return;
    await runFlow(async () => {
      const built = await service.buildBackupArchive("backup", passphrase, setSteps);
      if (!built.ok) throw built.error;
      setSteps((prev) => [...prev, { id: "driveUpload", titleKey: "step.driveUpload", status: "running" }]);
      try {
        const token = await getToken();
        if (!token) throw new AppError("DRIVE_AUTH");
        const existing = await drive.listBackups(token);
        await drive.uploadBackup(token, built.value.zip, existing[0]?.id ?? null);
      } catch (e) {
        setSteps((prev) => prev.map((s) => (s.id === "driveUpload" ? { ...s, status: "error" } : s)));
        throw e;
      }
      setSteps((prev) => prev.map((s) => (s.id === "driveUpload" ? { ...s, status: "done" } : s)));
      // The passphrase is kept on this device so auto-sync can encrypt
      // without asking. It is never written into a backup file.
      await writeDriveState(getStorage().settings, { lastBackupAt: Date.now(), passphrase });
      setHeldBytes(null);
      await reloadState();
      setStatus(t("drive.saved"));
    });
  }

  /**
   * Restore in two phases, on purpose: phase 1 fetches the backup from
   * Drive and holds it; the passphrase is only asked for afterwards, and
   * phase 2 inspects it. When the passphrase is already filled, one tap
   * runs both phases. The inspected backup goes through the same review
   * dialog as a file restore, so nothing is applied blind.
   */
  async function restore() {
    if (!heldBytes) {
      await runFlow(async () => {
        const token = await getToken();
        if (!token) throw new AppError("DRIVE_AUTH");
        setSteps([{ id: "driveDownload", titleKey: "step.driveDownload", status: "running" }]);
        const found = await drive.listBackups(token);
        if (found.length === 0) {
          setStatus(t("drive.noBackup"));
          return;
        }
        const bytes = await drive.downloadBackup(token, found[0].id);
        setSteps([{ id: "driveDownload", titleKey: "step.driveDownload", status: "done" }]);
        setHeldBytes(bytes);
        if (!drivePass) {
          setStatus(t("drive.enterPassphrase"));
          return;
        }
        await inspectBytes(bytes);
      });
      return;
    }
    await inspectBytes(heldBytes);
  }

  async function inspectBytes(bytes: Uint8Array) {
    if (!drivePass) {
      setFormError(t("validation.required", { field: t("drive.passphrase") }));
      return;
    }
    // Letters and digits only, like every passphrase entry: a backup made
    // before the rule with symbols in its passphrase cannot be opened here.
    if (!isAlphanumericPassphrase(drivePass)) {
      setFormError(t("validation.alphanumeric", { field: t("drive.passphrase") }));
      return;
    }
    const file: FileLike = { name: DRIVE_BACKUP_FILENAME, size: bytes.length, arrayBuffer: async () => bytes.slice().buffer as ArrayBuffer };
    await runFlow(async () => {
      const inspected = await service.inspect(file, setSteps, drivePass);
      if (!inspected.ok) throw inspected.error;
      setHeldBytes(null);
      setDecisions(new Map());
      setPlan(inspected.value);
    });
  }

  async function applyRestore() {
    if (!plan) return;
    setConfirm(false);
    setApplyError(null);
    setApplyResult(null);
    setBusy(true);
    try {
      const out = await service.restore(
        plan,
        {
          safetyBackup: safety,
          safetyPassphrase: plan.manifest.encryption ? drivePass : undefined,
          decisions,
          onRestored,
        },
        setApplySteps,
      );
      if (!out.ok) throw out.error;
      setApplyResult(out.value);
      errorCenter.notify({ key: "toast.restored" });
      await reloadState();
    } catch (e) {
      await fail(e);
      setApplyError(AppError.from(e));
    } finally {
      setBusy(false);
    }
  }

  async function toggleSync(on: boolean) {
    setError(null);
    if (!on) {
      try {
        await syncManager.setSyncEnabled(false);
        await reloadState();
      } catch (e) {
        await fail(e);
      }
      return;
    }
    // Turning on: with a stored passphrase sync starts at once. Without one,
    // the setup dialog collects it first; sync stays off until then, and the
    // toggle, controlled by the stored state, keeps showing off.
    try {
      const fresh = await readDriveState(getStorage().settings);
      if (fresh.passphrase) {
        await syncManager.setSyncEnabled(true);
        await reloadState();
        return;
      }
    } catch (e) {
      await fail(e);
      return;
    }
    setSetupPass("");
    setSetupPassConfirm("");
    setShowSetupPass(false);
    setShowSetupPassConfirm(false);
    setSetupStep("form");
    setSetupOpen(true);
  }

  /** Closes the setup dialog and clears its fields. In the form step this is a cancel: sync was never enabled, so the toggle stays off and nothing is stored. In the download step sync is already on. */
  function closeSetup() {
    setSetupOpen(false);
    setSetupPass("");
    setSetupPassConfirm("");
    setSetupStep("form");
  }

  /** Stores the setup passphrase and turns sync on, then moves to the download step. */
  async function confirmSetup() {
    if (!setupValid) return;
    setBusy(true);
    try {
      await writeDriveState(getStorage().settings, { passphrase: setupPass });
      await syncManager.setSyncEnabled(true);
      await reloadState();
      setSetupStep("download");
    } catch (e) {
      await fail(e);
      setSetupOpen(false);
    } finally {
      setBusy(false);
    }
  }

  /** Downloads the stored passphrase as JSON. Triggered only by the user's tap on the download button. */
  function downloadPassphraseFile() {
    const blob = new Blob([buildDrivePassphraseFile(setupPass)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = DRIVE_PASSPHRASE_FILENAME;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  async function saveClientId() {
    setError(null);
    try {
      await writeDriveState(getStorage().settings, { clientId: clientId.trim() || null });
      await reloadState();
      setStatus(t("drive.clientIdSaved"));
    } catch (e) {
      await fail(e);
    }
  }

  async function clearOverride() {
    setClientId("");
    setShowOwnId(false);
    try {
      await writeDriveState(getStorage().settings, { clientId: null });
      await reloadState();
    } catch (e) {
      await fail(e);
    }
  }

  const replacedCount = plan ? plan.merge.entries.filter((e) => e.status === "differs" && decisions.get(e.key) === "replace").length : 0;

  return (
    <section data-tour="drive" className="rounded-card border border-line bg-surface p-4">
      <h2 className="text-base font-semibold text-plum-900">{t("drive.title")}</h2>
      <p className="mt-1 text-sm text-muted">{t("drive.hint")}</p>

      <p className="mt-4 text-sm text-ink">
        {t("drive.status")}: <strong>{connected ? t("drive.connected") : t("drive.notConnected")}</strong>
        {state?.lastBackupAt ? ` · ${t("drive.lastBackup")}: ${formatDateTime(state.lastBackupAt, locale)}` : ""}
        {syncState.lastSyncedAt ? ` · ${t("drive.lastSynced")}: ${formatDateTime(syncState.lastSyncedAt, locale)}` : ""}
      </p>

      {hasDefault ? (
        <p className="mt-1 text-sm text-muted">{t("drive.sharedIdHint")}</p>
      ) : null}

      {showOwnId ? (
        <div className="mt-4 flex flex-col gap-1">
          <label htmlFor="drive-client-id" className="text-sm font-medium text-ink">
            {t("drive.clientIdOwn")}
          </label>
          <input
            id="drive-client-id"
            type="text"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            placeholder="xxx.apps.googleusercontent.com"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className="h-10 rounded-control border border-line bg-surface px-3 text-sm"
          />
        </div>
      ) : null}

      <div className="mt-4 flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-sm font-medium text-ink">
          {t("drive.passphrase")}
          <input type="password" autoComplete="new-password" value={drivePass} onChange={(e) => setDrivePass(e.target.value)} placeholder={t("drive.passphrasePlaceholder")} className="h-10 rounded-control border border-line bg-surface px-3 font-normal" />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium text-ink">
          {t("drive.passphraseConfirm")}
          <input type="password" autoComplete="new-password" value={drivePassConfirm} onChange={(e) => setDrivePassConfirm(e.target.value)} placeholder={t("drive.passphrasePlaceholder")} className="h-10 rounded-control border border-line bg-surface px-3 font-normal" />
        </label>
        <p className="text-xs text-muted">{t("drive.passphraseHint")}</p>
      </div>

      <div className="mt-4 grid gap-2">
        {!connected && (
          <Button className="w-full" onClick={() => void connect()} disabled={busy}>
            {t("drive.connect")}
          </Button>
        )}
        <Button className="w-full" onClick={() => void backup()} disabled={busy || !connected}>
          {t("drive.backup")}
        </Button>
        <Button variant="soft" className="w-full" onClick={() => void restore()} disabled={busy || !connected}>
          {t("drive.restore")}
        </Button>
        {connected && (
          <Button variant="ghost" className="w-full text-red-700" onClick={() => void disconnect()} disabled={busy}>
            {t("drive.disconnect")}
          </Button>
        )}
      </div>

      <div className="mt-4 border-t border-line pt-4">
        <Switch
          checked={state?.syncEnabled ?? false}
          onChange={(on) => void toggleSync(on)}
          label={t("drive.sync")}
          description={t("drive.syncHint")}
          disabled={busy || !connected}
        />
        {!connected && <p className="mt-1 text-xs text-muted">{t("drive.syncNeedsConnect")}</p>}
        {syncState.status === "syncing" && <p className="mt-1 text-xs text-muted">{t("drive.syncing")}</p>}
        {syncState.status === "error" && syncState.lastError && (
          <p className="mt-1 text-xs text-red-700">{t("drive.syncError", { error: syncState.lastError })}</p>
        )}
      </div>

      {hasDefault && (
        <div className="mt-4 flex flex-wrap gap-2">
          {showOwnId ? (
            <>
              <Button variant="soft" className="max-sm:h-11" onClick={() => void saveClientId()} disabled={busy}>
                {t("drive.saveClientId")}
              </Button>
              {state?.clientId ? (
                <Button variant="ghost" className="max-sm:h-11" onClick={() => void clearOverride()} disabled={busy}>
                  {t("drive.useDefault")}
                </Button>
              ) : (
                <Button variant="ghost" className="max-sm:h-11" onClick={() => setShowOwnId(false)} disabled={busy}>
                  {t("drive.hideOwnId")}
                </Button>
              )}
            </>
          ) : (
            <Button variant="ghost" className="max-sm:h-11" onClick={() => setShowOwnId(true)} disabled={busy}>
              {t("drive.useOwnId")}
            </Button>
          )}
        </div>
      )}

      {steps.length > 0 && <div className="mt-4"><Stepper steps={steps} /></div>}
      {status && (
        <p className="mt-4 text-sm text-plum-900" role="status">
          {status}
        </p>
      )}
      {formError && (
        <p className="mt-4 text-sm text-red-700" role="alert">
          {formError}
        </p>
      )}
      {error && <ErrorPanel error={error} className="mt-4" />}

      <Modal open={plan !== null} onOpenChange={(next) => { if (!next) { setPlan(null); setApplySteps([]); setApplyError(null); setApplyResult(null); } }} title={t("restore.review")} width="md:max-w-2xl">
        {plan && (
          <>
            {applySteps.length === 0 && !applyResult && (
              <RestoreReview
                plan={plan}
                decisions={decisions}
                onDecide={(key, d) => setDecisions((m) => new Map(m).set(key, d))}
                onDecideAll={(d) => setDecisions(new Map(plan.merge.entries.filter((e) => e.status === "differs").map((e) => [e.key, d] as const)))}
                safety={safety}
                onSafety={setSafety}
                onApply={() => setConfirm(true)}
                onBack={() => setPlan(null)}
              />
            )}
            {applySteps.length > 0 && <Stepper steps={applySteps} />}
            {applyError && <ErrorPanel error={applyError} className="mt-4" />}
            {applyResult && (
              <div className="rounded-card border border-plum-100 bg-plum-50 p-4">
                <p className="font-medium text-plum-900">{t("restore.doneTitle")}</p>
                <p className="mt-1 text-sm text-muted">{t("restore.doneBody")}</p>
                <p className="mt-1 text-sm text-plum-900">{t("merge.outcome", { added: applyResult.added, replaced: applyResult.replaced, kept: applyResult.kept })}</p>
                <Button className="mt-3" onClick={() => { setPlan(null); setApplySteps([]); setApplyResult(null); }}>
                  {t("action.done")}
                </Button>
              </div>
            )}
          </>
        )}
      </Modal>

      <Modal
        open={setupOpen}
        onOpenChange={(next) => {
          if (!next) closeSetup();
        }}
        title={t(setupStep === "form" ? "drive.syncSetupTitle" : "drive.syncDownloadTitle")}
      >
        {setupStep === "form" ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-muted">{t("drive.syncSetupBody")}</p>
            <div className="flex flex-col gap-1">
              <label htmlFor="drive-setup-passphrase" className="text-sm font-medium text-ink">
                {t("drive.passphrase")}
              </label>
              <span className="relative block">
                <input
                  id="drive-setup-passphrase"
                  type={showSetupPass ? "text" : "password"}
                  autoComplete="new-password"
                  value={setupPass}
                  onChange={(e) => setSetupPass(e.target.value)}
                  placeholder={t("drive.passphrasePlaceholder")}
                  className="h-10 w-full rounded-control border border-line bg-surface px-3 pr-24 font-normal"
                />
                <button
                  type="button"
                  onClick={() => setShowSetupPass((v) => !v)}
                  aria-label={t(showSetupPass ? "drive.hidePassword" : "drive.showPassword")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-xs font-medium text-plum-600 hover:underline"
                >
                  {t(showSetupPass ? "drive.hidePassword" : "drive.showPassword")}
                </button>
              </span>
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="drive-setup-passphrase-confirm" className="text-sm font-medium text-ink">
                {t("drive.passphraseConfirm")}
              </label>
              <span className="relative block">
                <input
                  id="drive-setup-passphrase-confirm"
                  type={showSetupPassConfirm ? "text" : "password"}
                  autoComplete="new-password"
                  value={setupPassConfirm}
                  onChange={(e) => setSetupPassConfirm(e.target.value)}
                  placeholder={t("drive.passphrasePlaceholder")}
                  className="h-10 w-full rounded-control border border-line bg-surface px-3 pr-24 font-normal"
                />
                <button
                  type="button"
                  onClick={() => setShowSetupPassConfirm((v) => !v)}
                  aria-label={t(showSetupPassConfirm ? "drive.hidePassword" : "drive.showPassword")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-xs font-medium text-plum-600 hover:underline"
                >
                  {t(showSetupPassConfirm ? "drive.hidePassword" : "drive.showPassword")}
                </button>
              </span>
            </div>
            <p className="text-xs text-muted">{t("drive.syncSetupPassphraseHint")}</p>
            {setupError && (
              <p role="alert" className="text-sm text-red-700">
                {setupError}
              </p>
            )}
            <div className="mt-1 flex flex-wrap justify-end gap-2">
              <Button variant="ghost" onClick={closeSetup} disabled={busy}>
                {t("action.cancel")}
              </Button>
              <Button onClick={() => void confirmSetup()} disabled={!setupValid || busy}>
                {t("action.confirm")}
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-muted">{t("drive.syncDownloadBody")}</p>
            <div className="mt-1 flex flex-wrap gap-2">
              <Button icon="download" onClick={downloadPassphraseFile}>
                {t("drive.downloadPassphrase")}
              </Button>
              <Button variant="ghost" onClick={closeSetup}>
                {t("action.done")}
              </Button>
            </div>
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={confirm}
        danger
        title={t("restore.confirmTitle")}
        body={t("restore.confirmBody", { name: plan?.fileName ?? "", added: plan?.merge.totals.new ?? 0, replaced: replacedCount })}
        confirmLabel={t("restore.confirmAction")}
        cancelLabel={t("action.cancel")}
        onCancel={() => setConfirm(false)}
        onConfirm={() => void applyRestore()}
      />
    </section>
  );
}
