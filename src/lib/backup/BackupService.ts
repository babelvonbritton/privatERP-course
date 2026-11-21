import type { Msg } from "@/i18n/types";
import { AppError } from "@/lib/errors/AppError";
import type { ErrorCenter } from "@/lib/errors/ErrorCenter";
import { setCurrency } from "@/lib/currency";
import type { BackupData } from "@/lib/domain/types";
import type { StorageService } from "@/lib/storage";
import { AttachmentService } from "@/lib/attachments/service";
import { ArchiveCodec } from "./ArchiveCodec";
import { BackupCrypto, type DerivedBackupKey } from "./BackupCrypto";
import { BackupValidator } from "./BackupValidator";
import {
  BACKUP_STORE_NAMES,
  CONFIGURATION_NAME,
  DATA_NAME,
  MANIFEST_NAME,
  MAX_ARCHIVE_BYTES,
  STORE_NAMES,
  STORE_TO_FILE,
  type StoreName,
} from "./constants";
import { FileSaver } from "./FileSaver";
import { sha256Hex } from "./hash";
import { decodeConfiguration, decodeNdjson } from "./Ndjson";
import { StepRunner, type StepDef, type StepOutcome } from "./StepRunner";
import { MergePlanner, type Decision, type MergeResult } from "./MergePlanner";
import type { BackupAsset, BackupKind, BackupManifest, BackupResult, Outcome, RestorePlan, StepState, VerifiedArchive } from "./types";

/** The part of a File the service needs (also satisfied by test doubles). */
export interface FileLike {
  name: string;
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface RestoreOptions {
  safetyBackup: boolean;
  safetyPassphrase?: string;
  /** The user's choice for each record that differs, keyed by MergeEntry.key. Anything not listed is kept as it is. */
  decisions: ReadonlyMap<string, Decision>;
  /** Called after data is replaced so the UI can reload its state. */
  onRestored: () => Promise<void>;
}

type Progress = (steps: StepState[]) => void;

const pad = (n: number) => String(n).padStart(2, "0");
const kb = (bytes: number) => (bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

function countsOf(data: BackupData): Record<StoreName, number> {
  return Object.fromEntries(STORE_NAMES.map((n) => [n, data[n].length])) as Record<StoreName, number>;
}
const totalOf = (counts: Record<StoreName, number>) => STORE_NAMES.reduce((sum, n) => sum + counts[n], 0);

/** Attachments have no store yet, so older snapshots may omit the list; treat a missing list as empty. */
function withAttachments(data: BackupData): BackupData {
  return { ...data, attachments: data.attachments ?? [] };
}

const isAssetName = (name: string) => name.startsWith("assets/");

/** True when the archive holds a file for this attachment, matched by attachment id. */
function hasAssetFile(assets: Map<string, Uint8Array>, id: string): boolean {
  for (const name of assets.keys()) {
    if (name === `assets/images/${id}` || name.startsWith(`assets/images/${id}.`)) return true;
  }
  return false;
}

/** Creates, verifies and restores backups. Every flow reports step by step and returns an Outcome instead of throwing. */
export class BackupService {
  constructor(
    private readonly storage: StorageService,
    private readonly errors: ErrorCenter,
    private readonly options: { minStepMs?: number; clock?: () => number } = {},
  ) {}

  private now(): number {
    return (this.options.clock ?? Date.now)();
  }

  private runner<C>(steps: StepDef<C>[]): StepRunner<C> {
    return new StepRunner(steps, this.errors, this.options.minStepMs);
  }

  static fileName(kind: BackupKind, ms: number): string {
    const d = new Date(ms);
    const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
    return `olaseena-${kind === "safety" ? "safety-backup" : "backup"}-${stamp}.zip`;
  }

  /** Record counts now in the database, for comparing with a backup before restoring. */
  async currentCounts(): Promise<Record<StoreName, number>> {
    return countsOf(await this.storage.snapshots.readAll());
  }

  // ---------------------------------------------------------------- shared building blocks

  /** Attachment blobs are read and written through this service; its audit hook is never called on the backup paths. */
  private attachmentService(): AttachmentService {
    return new AttachmentService(this.storage.db, async () => {});
  }

  /** Builds a new-format archive from data, encrypting every file when a passphrase is given. Attachment files are always collected from the blob store, plus any assets the caller passes. */
  private async buildArchive(data: BackupData, kind: BackupKind, passphrase?: string, assets?: BackupAsset[]): Promise<{ zip: Uint8Array; manifest: BackupManifest }> {
    let collected: BackupAsset[];
    try {
      collected = await this.attachmentService().listBlobs();
    } catch (e) {
      throw new AppError("BACKUP_COLLECT_FAILED", { cause: e, details: AppError.from(e).details });
    }
    const { files, manifest } = await ArchiveCodec.describe(withAttachments(data), this.now(), kind, [...collected, ...(assets ?? [])]);
    const key = passphrase === undefined ? undefined : await BackupCrypto.createKey(passphrase);
    return ArchiveCodec.pack(manifest, files, key);
  }

  /** Unpacks, checks metadata and checksums, and validates a ZIP. Used by restore and to verify new backups. */
  async verifyArchive(zip: Uint8Array, passphrase?: string): Promise<VerifiedArchive> {
    const { manifestBytes, files } = ArchiveCodec.unpack(zip);
    const manifest = BackupValidator.validateManifest(ArchiveCodec.parseJson(manifestBytes, "BACKUP_MANIFEST_INVALID", "manifest.json"));
    if (manifest.formatVersion === 1) {
      const dataBytes = files.get(DATA_NAME);
      if (!dataBytes) throw new AppError("BACKUP_UNEXPECTED_CONTENT", { details: `Both ${MANIFEST_NAME} and ${DATA_NAME} are required` });
      const payload = manifest.encryption ? await BackupCrypto.decrypt(dataBytes, manifest.encryption, passphrase) : dataBytes;
      const raw = await this.verifyContentsV1(manifest, payload);
      const result = BackupValidator.validateData(raw, this.now());
      return { manifest, data: result.data, warnings: result.warnings, total: result.total, counts: countsOf(result.data), assets: new Map() };
    }
    const { raw, assets, warnings } = await this.verifyContentsV2(manifest, files, passphrase);
    const result = BackupValidator.validateData(raw, this.now());
    return { manifest, data: result.data, warnings: [...warnings, ...result.warnings], total: result.total, counts: countsOf(result.data), assets };
  }

  /** Size and checksum checks of data.json against the manifest, overall and per store. Returns the parsed JSON. */
  private async verifyContentsV1(manifest: BackupManifest, dataBytes: Uint8Array): Promise<unknown> {
    const file = manifest.files[0];
    if (dataBytes.length !== file.bytes) throw new AppError("BACKUP_SIZE_MISMATCH", { details: `data.json is ${dataBytes.length} bytes, manifest says ${file.bytes}` });
    const actual = await sha256Hex(dataBytes);
    if (actual !== file.sha256) throw new AppError("BACKUP_CHECKSUM_MISMATCH", { details: `data.json SHA-256\nexpected ${file.sha256}\nfound    ${actual}` });
    const raw = ArchiveCodec.parseJson(dataBytes, "BACKUP_STRUCTURE_INVALID", "data.json");
    if (typeof raw !== "object" || raw === null) throw new AppError("BACKUP_STRUCTURE_INVALID", { details: "data.json must be an object" });
    for (const name of STORE_NAMES) {
      const list = (raw as Record<string, unknown>)[name];
      if (!Array.isArray(list)) throw new AppError("BACKUP_STRUCTURE_INVALID", { details: `${name} must be a list` });
      const expected = manifest.stores[name];
      if (list.length !== expected.count) throw new AppError("BACKUP_CHECKSUM_MISMATCH", { details: `${name}: ${list.length} records, manifest says ${expected.count}` });
      if ((await sha256Hex(new TextEncoder().encode(JSON.stringify(list)))) !== expected.sha256) {
        throw new AppError("BACKUP_CHECKSUM_MISMATCH", { details: `Checksum of store "${name}" does not match the manifest` });
      }
    }
    return raw;
  }

  /**
   * Verifies a format 2 archive: every manifest file is decrypted when the
   * backup is encrypted, then checked for size and checksum against the
   * manifest before anything is decoded. A missing or damaged attachment
   * file is not fatal: its metadata row is kept and reported as a warning.
   * A missing or damaged database or settings file fails the whole restore.
   */
  private async verifyContentsV2(
    manifest: BackupManifest,
    files: Map<string, Uint8Array>,
    passphrase?: string,
    key?: CryptoKey,
  ): Promise<{ raw: unknown; assets: Map<string, Uint8Array>; warnings: Msg[] }> {
    let derived = key;
    if (manifest.encryption) {
      if (!passphrase) throw new AppError("BACKUP_PASSWORD_REQUIRED");
      derived ??= await BackupCrypto.deriveFromSalt(passphrase, manifest.encryption.salt);
    }
    const plain = new Map<string, Uint8Array>();
    const missingAssetNames = new Set<string>();
    for (const entry of manifest.files) {
      const stored = files.get(entry.name);
      if (!stored) {
        if (isAssetName(entry.name)) {
          missingAssetNames.add(entry.name);
          continue;
        }
        throw new AppError("BACKUP_UNEXPECTED_CONTENT", { details: `${entry.name} is listed in the manifest but missing from the archive` });
      }
      let bytes = stored;
      if (derived) {
        if (!entry.iv) throw new AppError("BACKUP_MANIFEST_INVALID", { details: `${entry.name} has no IV` });
        try {
          bytes = await BackupCrypto.decryptWithKey(stored, derived, entry.iv);
        } catch (e) {
          // A damaged attachment file is not fatal, exactly like a missing
          // or checksum-wrong one: keep the metadata row and warn. Without
          // this, one flipped bit in one photo would block the whole
          // restore of an encrypted backup. Other files still fail hard.
          if (isAssetName(entry.name)) {
            missingAssetNames.add(entry.name);
            continue;
          }
          throw e;
        }
      }
      if (bytes.length !== entry.bytes) {
        if (isAssetName(entry.name)) {
          missingAssetNames.add(entry.name);
          continue;
        }
        throw new AppError("BACKUP_SIZE_MISMATCH", { details: `${entry.name} is ${bytes.length} bytes, manifest says ${entry.bytes}` });
      }
      const actual = await sha256Hex(bytes);
      if (actual !== entry.sha256) {
        if (isAssetName(entry.name)) {
          missingAssetNames.add(entry.name);
          continue;
        }
        throw new AppError("BACKUP_CHECKSUM_MISMATCH", { details: `Checksum of ${entry.name} does not match the manifest\nexpected ${entry.sha256}\nfound    ${actual}` });
      }
      plain.set(entry.name, bytes);
    }
    for (const name of files.keys()) {
      if (name === MANIFEST_NAME) continue;
      if (!manifest.files.some((f) => f.name === name)) throw new AppError("BACKUP_UNEXPECTED_CONTENT", { details: `Unexpected entry: ${name}` });
    }

    const warnings: Msg[] = [];
    const raw: Record<string, unknown> = {};
    for (const name of BACKUP_STORE_NAMES) {
      if (name === "settings") continue;
      const path = STORE_TO_FILE[name];
      const bytes = plain.get(path);
      if (!bytes) {
        // Backups written before the trash bin carry no trash file: they
        // restore with an empty trash, and the count and checksum checks
        // below are skipped for it.
        if (name === "trash") {
          raw.trash = [];
          continue;
        }
        throw new AppError("BACKUP_UNEXPECTED_CONTENT", { details: `${path} is listed in the manifest but missing from the archive` });
      }
      const decoded = decodeNdjson(bytes, path);
      if (decoded.badLines > 0) warnings.push({ key: "warn.badLines", vars: { count: decoded.badLines, store: name } });
      const expected = manifest.stores[name];
      if (decoded.records.length + decoded.badLines !== expected.count) {
        throw new AppError("BACKUP_CHECKSUM_MISMATCH", { details: `${name}: ${decoded.records.length} records, manifest says ${expected.count}` });
      }
      if ((await sha256Hex(bytes)) !== expected.sha256) {
        throw new AppError("BACKUP_CHECKSUM_MISMATCH", { details: `Checksum of store "${name}" does not match the manifest` });
      }
      raw[name] = decoded.records;
    }
    const configBytes = plain.get(CONFIGURATION_NAME);
    if (!configBytes) throw new AppError("BACKUP_UNEXPECTED_CONTENT", { details: `${CONFIGURATION_NAME} is listed in the manifest but missing from the archive` });
    const settings = decodeConfiguration(configBytes);
    raw.settings = settings;
    if (settings.length !== manifest.stores.settings.count) {
      throw new AppError("BACKUP_CHECKSUM_MISMATCH", { details: `settings: ${settings.length} records, manifest says ${manifest.stores.settings.count}` });
    }

    const assets = new Map<string, Uint8Array>();
    for (const [name, bytes] of plain) if (isAssetName(name)) assets.set(name, bytes);
    const missingIds = new Set<string>();
    const sizeMismatchIds = new Set<string>();
    for (const row of raw.attachments as unknown[]) {
      if (typeof row !== "object" || row === null || Array.isArray(row)) continue;
      const rec = row as Record<string, unknown>;
      const id = rec.id;
      if (typeof id !== "string") continue;
      if (!hasAssetFile(assets, id)) {
        missingIds.add(id);
        continue;
      }
      if (typeof rec.sizeBytes !== "number") continue;
      for (const [name, bytes] of assets) {
        if (name === `assets/images/${id}` || name.startsWith(`assets/images/${id}.`)) {
          if (bytes.length !== rec.sizeBytes) sizeMismatchIds.add(id);
          break;
        }
      }
    }
    for (const name of missingAssetNames) {
      const match = /^assets\/images\/([A-Za-z0-9_-]+)\./.exec(name);
      if (match) missingIds.add(match[1]);
    }
    if (missingIds.size > 0) warnings.push({ key: "warn.missingAssets", vars: { count: missingIds.size } });
    if (sizeMismatchIds.size > 0) warnings.push({ key: "warn.assetSizeMismatch", vars: { count: sizeMismatchIds.size } });
    return { raw, assets, warnings };
  }

  // ---------------------------------------------------------------- create a backup

  /** Reads, checks, packages, compresses, re-verifies and saves a backup ZIP. */
  async createBackup(onChange: Progress, kind: BackupKind = "backup", passphrase?: string, assets?: BackupAsset[]): Promise<Outcome<BackupResult>> {
    interface Ctx { data?: BackupData; noticeCount: number; files?: Map<string, Uint8Array>; plainBytes?: number; key?: DerivedBackupKey; manifest?: BackupManifest; zip?: Uint8Array; fileName?: string; total: number; collectedAssets?: BackupAsset[] }
    const ctx: Ctx = { noticeCount: 0, total: 0 };
    const steps: StepDef<Ctx>[] = [
      {
        id: "collect",
        titleKey: "step.collect",
        run: async (c) => {
          try {
            c.data = withAttachments(await this.storage.snapshots.readAll());
            c.collectedAssets = await this.attachmentService().listBlobs();
          } catch (e) {
            throw new AppError("BACKUP_COLLECT_FAILED", { cause: e, details: AppError.from(e).details });
          }
          const n = countsOf(c.data);
          return { detail: { key: "detail.collected", vars: { total: totalOf(n) } } };
        },
      },
      {
        id: "selfcheck",
        titleKey: "step.selfcheck",
        run: async (c) => {
          try {
            const result = BackupValidator.validateData(JSON.parse(JSON.stringify(c.data)), this.now());
            c.noticeCount = result.warnings.length;
            c.total = result.total;
            const outcome: StepOutcome = result.warnings.length
              ? { warning: true, detail: { key: "detail.validNotices", vars: { total: result.total, count: result.warnings.length } } }
              : { detail: { key: "detail.valid", vars: { total: result.total } } };
            return outcome;
          } catch (e) {
            const inner = AppError.from(e);
            throw new AppError("BACKUP_SELFCHECK_FAILED", { cause: e, details: inner.details });
          }
        },
      },
      {
        id: "package",
        titleKey: "step.package",
        run: async (c) => {
          try {
            const { files, manifest } = await ArchiveCodec.describe(c.data!, this.now(), kind, [...(c.collectedAssets ?? []), ...(assets ?? [])]);
            c.files = files;
            c.manifest = manifest;
            c.plainBytes = [...files.values()].reduce((sum, b) => sum + b.length, 0);
            return { detail: { key: "detail.packaged", vars: { files: files.size, size: kb(c.plainBytes), hash: manifest.files[0].sha256.slice(0, 12) } } };
          } catch (e) {
            if (e instanceof AppError) throw e;
            throw new AppError("BACKUP_PACKAGE_FAILED", { cause: e, details: AppError.from(e).details });
          }
        },
      },
      {
        id: "encrypt",
        titleKey: "step.encrypt",
        run: async (c) => {
          if (passphrase === undefined) return { skipped: true, detail: { key: "detail.encryptionSkipped" } };
          c.key = await BackupCrypto.createKey(passphrase);
          return { detail: { key: "detail.encrypted" } };
        },
      },
      {
        id: "compress",
        titleKey: "step.compress",
        run: async (c) => {
          try {
            const packed = await ArchiveCodec.pack(c.manifest!, c.files!, c.key);
            c.zip = packed.zip;
            c.manifest = packed.manifest;
            return { detail: { key: "detail.compressed", vars: { size: kb(c.zip.length), original: kb(c.plainBytes!) } } };
          } catch (e) {
            throw new AppError("BACKUP_PACKAGE_FAILED", { cause: e, details: AppError.from(e).details });
          }
        },
      },
      {
        id: "verifyArchive",
        titleKey: "step.verifyArchive",
        run: async (c) => {
          try {
            const plan = await this.verifyArchive(c.zip!, passphrase);
            if (plan.total !== c.total) throw new Error(`record count differs after round trip (${plan.total} vs ${c.total})`);
            return { detail: { key: "detail.archiveVerified", vars: { total: plan.total } } };
          } catch (e) {
            throw new AppError("BACKUP_ARCHIVE_INVALID", { cause: e, details: AppError.from(e).details });
          }
        },
      },
      {
        id: "save",
        titleKey: "step.save",
        run: async (c) => {
          c.fileName = BackupService.fileName(kind, c.manifest!.createdAtMs);
          FileSaver.download(c.zip!, c.fileName);
          return { detail: { key: "detail.saved", vars: { name: c.fileName } } };
        },
      },
    ];
    const outcome = await this.runner(steps).run(ctx, onChange, "backup");
    if (!outcome.ok) return outcome;
    return { ok: true, value: { fileName: ctx.fileName!, bytes: ctx.zip!.length, zip: ctx.zip!, manifest: ctx.manifest!, total: ctx.total } };
  }

  // ---------------------------------------------------------------- inspect a file before restoring

  /** Reads and verifies a backup file completely. Nothing is written to the database. */
  async inspect(file: FileLike, onChange: Progress, passphrase?: string): Promise<Outcome<RestorePlan>> {
    interface Ctx { bytes?: Uint8Array; manifestBytes?: Uint8Array; files?: Map<string, Uint8Array>; dataBytes?: Uint8Array; key?: CryptoKey; manifest?: BackupManifest; raw?: unknown; warnings?: Msg[]; assets?: Map<string, Uint8Array>; result?: ReturnType<typeof BackupValidator.validateData>; plan?: RestorePlan }
    const ctx: Ctx = {};
    const steps: StepDef<Ctx>[] = [
      {
        id: "readFile",
        titleKey: "step.readFile",
        run: async (c) => {
          if (file.size > MAX_ARCHIVE_BYTES) throw new AppError("BACKUP_FILE_TOO_LARGE", { details: `${file.size} bytes` });
          try {
            c.bytes = new Uint8Array(await file.arrayBuffer());
          } catch (e) {
            throw new AppError("BACKUP_FILE_READ_FAILED", { cause: e, details: AppError.from(e).details });
          }
          return { detail: { key: "detail.read", vars: { name: file.name, size: kb(c.bytes.length) } } };
        },
      },
      {
        id: "unpack",
        titleKey: "step.unpack",
        run: async (c) => {
          const { manifestBytes, files } = ArchiveCodec.unpack(c.bytes!);
          c.manifestBytes = manifestBytes;
          c.files = files;
          c.dataBytes = files.get(DATA_NAME);
          return { detail: { key: "detail.unpacked" } };
        },
      },
      {
        id: "metadata",
        titleKey: "step.metadata",
        run: async (c) => {
          c.manifest = BackupValidator.validateManifest(ArchiveCodec.parseJson(c.manifestBytes!, "BACKUP_MANIFEST_INVALID", "manifest.json"));
          const m = c.manifest;
          return { detail: { key: "detail.metadata", vars: { format: m.formatVersion, date: m.createdAt.slice(0, 16).replace("T", " "), version: m.app.version } } };
        },
      },
      {
        id: "decrypt",
        titleKey: "step.decrypt",
        run: async (c) => {
          if (!c.manifest!.encryption) return { skipped: true, detail: { key: "detail.decryptionSkipped" } };
          if (c.manifest!.formatVersion === 1) {
            if (!c.dataBytes) throw new AppError("BACKUP_UNEXPECTED_CONTENT", { details: `${DATA_NAME} is required` });
            c.dataBytes = await BackupCrypto.decrypt(c.dataBytes, c.manifest!.encryption, passphrase);
            return { detail: { key: "detail.decrypted" } };
          }
          if (!passphrase) throw new AppError("BACKUP_PASSWORD_REQUIRED");
          c.key = await BackupCrypto.deriveFromSalt(passphrase, c.manifest!.encryption.salt);
          return { detail: { key: "detail.decrypted" } };
        },
      },
      {
        id: "checksum",
        titleKey: "step.checksum",
        run: async (c) => {
          if (c.manifest!.formatVersion === 1) {
            if (!c.dataBytes) throw new AppError("BACKUP_UNEXPECTED_CONTENT", { details: `${DATA_NAME} is required` });
            c.raw = await this.verifyContentsV1(c.manifest!, c.dataBytes);
            return { detail: { key: "detail.checksum", vars: { hash: c.manifest!.files[0].sha256.slice(0, 12), stores: STORE_NAMES.length } } };
          }
          const checked = await this.verifyContentsV2(c.manifest!, c.files!, passphrase, c.key);
          c.raw = checked.raw;
          c.assets = checked.assets;
          c.warnings = checked.warnings;
          return { detail: { key: "detail.checksum", vars: { hash: c.manifest!.files[0].sha256.slice(0, 12), stores: BACKUP_STORE_NAMES.length } } };
        },
      },
      {
        id: "structure",
        titleKey: "step.structure",
        run: async (c) => {
          const result = BackupValidator.validateData(c.raw, this.now());
          c.result = result;
          c.warnings = [...(c.warnings ?? []), ...result.warnings];
          const detail: Msg = c.warnings.length ? { key: "detail.validNotices", vars: { total: result.total, count: c.warnings.length } } : { key: "detail.valid", vars: { total: result.total } };
          return { detail, warning: c.warnings.length > 0 };
        },
      },
      {
        id: "compare",
        titleKey: "step.compare",
        run: async (c) => {
          let current: BackupData;
          try {
            current = withAttachments(await this.storage.snapshots.readAll());
          } catch (e) {
            throw new AppError("BACKUP_COLLECT_FAILED", { cause: e, details: AppError.from(e).details });
          }
          const result = c.result!;
          const merge = MergePlanner.plan(current, result.data);
          const fingerprint = await sha256Hex(new TextEncoder().encode(JSON.stringify(current)));
          c.plan = { fileName: file.name, manifest: c.manifest!, data: result.data, warnings: c.warnings ?? [], total: result.total, counts: countsOf(result.data), assets: c.assets ?? new Map(), current, merge, fingerprint };
          const { new: added, same, differs } = merge.totals;
          return { detail: { key: "detail.compared", vars: { added, same, differs } }, warning: differs > 0 };
        },
      },
    ];
    const outcome = await this.runner(steps).run(ctx, onChange, "restore.inspect");
    return outcome.ok ? { ok: true, value: ctx.plan! } : outcome;
  }

  // ---------------------------------------------------------------- apply the user's decisions

  /**
   * Merges the backup into the current data as the user decided: new records are added, records marked "replace"
   * are overwritten, everything else is untouched. The write is one atomic transaction, the result is verified, and
   * the previous data is put back if verification fails. If the data changed since the comparison, nothing is written.
   */
  async restore(plan: RestorePlan, options: RestoreOptions, onChange: Progress): Promise<Outcome<MergeResult>> {
    interface Ctx { previous?: BackupData; merged?: MergeResult }
    const ctx: Ctx = {};
    const steps: StepDef<Ctx>[] = [
      {
        id: "snapshot",
        titleKey: "step.snapshot",
        run: async (c) => {
          try {
            c.previous = withAttachments(await this.storage.snapshots.readAll());
          } catch (e) {
            throw new AppError("BACKUP_COLLECT_FAILED", { cause: e, details: AppError.from(e).details });
          }
          const fingerprint = await sha256Hex(new TextEncoder().encode(JSON.stringify(c.previous)));
          if (fingerprint !== plan.fingerprint) throw new AppError("BACKUP_STALE", { details: "The data changed after the comparison was made." });
          return { detail: { key: "detail.snapshot", vars: { total: totalOf(countsOf(c.previous)) } } };
        },
      },
      {
        id: "safety",
        titleKey: "step.safety",
        run: async (c) => {
          if (!options.safetyBackup) return { skipped: true, detail: { key: "detail.safetySkipped" } };
          const { zip, manifest } = await this.buildArchive(c.previous!, "safety", options.safetyPassphrase);
          try {
            await this.verifyArchive(zip, options.safetyPassphrase);
          } catch (e) {
            throw new AppError("BACKUP_ARCHIVE_INVALID", { cause: e, details: AppError.from(e).details });
          }
          const name = BackupService.fileName("safety", manifest.createdAtMs);
          FileSaver.download(zip, name);
          return { detail: { key: "detail.saved", vars: { name } } };
        },
      },
      {
        id: "apply",
        titleKey: "step.apply",
        run: async (c) => {
          // The data may have changed while the safety backup was being built; check again right before writing.
          let current: BackupData;
          try {
            current = withAttachments(await this.storage.snapshots.readAll());
          } catch (e) {
            throw new AppError("BACKUP_COLLECT_FAILED", { cause: e, details: AppError.from(e).details });
          }
          const fingerprint = await sha256Hex(new TextEncoder().encode(JSON.stringify(current)));
          if (fingerprint !== plan.fingerprint) throw new AppError("BACKUP_STALE", { details: "The data changed after the comparison was made." });
          c.merged = MergePlanner.resolve(plan.current, plan.data, options.decisions, this.now());
          try {
            // Blob bytes go in first: if the metadata write below fails, the
            // orphaned blobs stay invisible, while metadata without bytes
            // would show files as missing.
            await this.attachmentService().writeBlobs(plan.assets, c.merged.data.attachments ?? []);
            await this.storage.snapshots.replaceAll(c.merged.data);
          } catch (e) {
            throw new AppError("BACKUP_APPLY_FAILED", { cause: e, details: AppError.from(e).details });
          }
          return { detail: { key: "detail.applied", vars: { total: c.merged.total } } };
        },
      },
      {
        id: "verifyRestore",
        titleKey: "step.verifyRestore",
        run: async (c) => {
          let problem = "";
          try {
            const nowData = await this.storage.snapshots.readAll();
            const now = countsOf(nowData);
            const expected = countsOf(c.merged!.data);
            const mismatch: string[] = STORE_NAMES.filter((n) => now[n] !== expected[n]);
            if (nowData.attachments.length !== (c.merged!.data.attachments ?? []).length) mismatch.push("attachments");
            const integrity = await this.storage.integrity.run();
            if (mismatch.length) problem = `Record counts differ in: ${mismatch.join(", ")}`;
            else if (!integrity.ok) problem = integrity.issues.slice(0, 8).map((i) => `${i.code} ${i.id}`).join("\n");
          } catch (e) {
            problem = AppError.from(e).details ?? "verification failed";
          }
          if (!problem) return { detail: { key: "detail.restoreVerified" } };
          try {
            await this.storage.snapshots.replaceAll(c.previous!);
          } catch (e) {
            throw new AppError("BACKUP_ROLLBACK_FAILED", { cause: e, details: `${problem}\nRollback error: ${AppError.from(e).details}` });
          }
          throw new AppError("BACKUP_VERIFY_FAILED", { details: problem });
        },
      },
      {
        id: "refresh",
        titleKey: "step.refresh",
        run: async () => {
          await options.onRestored();
          // The restored settings may carry a different currency; re-read preferences
          // so amounts are formatted in the backup's currency from here on.
          const prefs = await this.storage.reloadPreferences();
          setCurrency(prefs.currency);
          return { detail: { key: "detail.refreshed" } };
        },
      },
    ];
    const outcome = await this.runner(steps).run(ctx, onChange, "restore.apply");
    if (!outcome.ok) return outcome;
    // Carry the inspection warnings (including missing attachment files) on the
    // result, so the UI can show which files are missing after the restore.
    return { ok: true, value: { ...ctx.merged!, warnings: plan.warnings } };
  }
}
