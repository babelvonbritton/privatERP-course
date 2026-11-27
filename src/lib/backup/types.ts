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
  iv?: string;
}

export interface BackupManifestFile {
  name: string;
  bytes: number;
  sha256: string;
  iv?: string;
}

export interface BackupManifest {
  format: string;
  formatVersion: number;
  schemaVersion: number;
  kind: BackupKind;
  app: { name: string; version: string };
  currency: CurrencyCode;
  createdAt: string;
  createdAtMs: number;
  stores: Record<BackupStoreName, { count: number; sha256: string }>;
  files: BackupManifestFile[];
  encryption?: BackupEncryption;
}

export interface BackupAsset {
  name: string;
  bytes: Uint8Array;
}

export type StepStatus = "pending" | "running" | "done" | "warning" | "error" | "skipped";

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

export interface VerifiedArchive {
  manifest: BackupManifest;
  data: BackupData;
  warnings: Msg[];
  total: number;
  counts: Record<StoreName, number>;
  assets: Map<string, Uint8Array>;
}

export interface RestorePlan extends VerifiedArchive {
  fileName: string;
  current: BackupData;
  merge: MergePlan;
  fingerprint: string;
}
