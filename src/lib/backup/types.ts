import type { AppError } from "@/lib/errors/AppError";
import type { Msg } from "@/i18n/types";
import type { BackupData, CurrencyCode } from "@/lib/domain/types";
import type { BackupStoreName, StoreName } from "./constants";
import type { MergePlan } from "./MergePlanner";

export type BackupKind = "backup" | "safety";

export interface BackupEncryption {
  algorithm: "AES-GCM";
  kdf: "PBKDF2-SHA-256";
  iterations: number;
  salt: string;
  /**
   * Format 1 only: the single IV for data.json. Format 2 leaves this unset
   * and records one IV per file in the files entries instead.
   */
  iv?: string;
}

/** One content file in the archive. Bytes and SHA-256 always refer to the plaintext, before any encryption. */
export interface BackupManifestFile {
  name: string;
  bytes: number;
  sha256: string;
  /** Present exactly when the backup is encrypted: the IV for this file. */
  iv?: string;
}

/** manifest.json: describes the archive so it can be verified before any data is read. */
export interface BackupManifest {
  format: string;
  formatVersion: number;
  schemaVersion: number;
  kind: BackupKind;
  app: { name: string; version: string };
  /** Currency the stored amounts are in. */
  currency: CurrencyCode;
  createdAt: string;
  createdAtMs: number;
  /** Per-store count plus SHA-256 of that store plaintext file bytes (NDJSON, or configuration.json for settings). */
  stores: Record<BackupStoreName, { count: number; sha256: string }>;
  files: BackupManifestFile[];
  encryption?: BackupEncryption;
}

/** One attachment file carried inside the archive, stored as raw bytes, never base64 in JSON. */
export interface BackupAsset {
  /** Path inside the ZIP, of the form assets/images/<attachmentId>.<ext>. */
  name: string;
  bytes: Uint8Array;
}

export type StepStatus = "pending" | "running" | "done" | "warning" | "error" | "skipped";

/** What the UI shows for one step. */
export interface StepState {
  id: string;
  titleKey: Msg["key"];
  status: StepStatus;
  detail?: Msg;
  error?: AppError;
}

export type Outcome<T> = { ok: true; value: T } | { ok: false; error: AppError };

export interface BackupResult {
  fileName: string;
  bytes: number;
  zip: Uint8Array;
  manifest: BackupManifest;
  total: number;
}

/** A backup file that passed every check, with its data validated and cleaned. */
export interface VerifiedArchive {
  manifest: BackupManifest;
  data: BackupData;
  warnings: Msg[];
  total: number;
  counts: Record<StoreName, number>;
  /** Plaintext bytes of the attachment files that were present and verified, keyed by ZIP path. */
  assets: Map<string, Uint8Array>;
}

/** A verified backup compared with the current data, ready for the user's decisions. */
export interface RestorePlan extends VerifiedArchive {
  fileName: string;
  /** The data as it was when the comparison was made. */
  current: BackupData;
  merge: MergePlan;
  /** SHA-256 of `current`; if the data changes before applying, the plan is stale and nothing is written. */
  fingerprint: string;
}
