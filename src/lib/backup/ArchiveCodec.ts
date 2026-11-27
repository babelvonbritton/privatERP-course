import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { AppError } from "@/lib/errors/AppError";
import type { BackupData } from "@/lib/domain/types";
import { APP_NAME, APP_VERSION } from "@/lib/appInfo";
import {
  BACKUP_FORMAT,
  BACKUP_FORMAT_VERSION,
  BACKUP_STORE_NAMES,
  CONFIGURATION_NAME,
  DATA_NAME,
  DB_SCHEMA_VERSION,
  MANIFEST_NAME,
  MAX_ARCHIVE_BYTES,
  MAX_ENTRIES,
  MAX_ENTRY_BYTES,
  MAX_TOTAL_INFLATED_BYTES,
  STORE_TO_FILE,
} from "./constants";
import { BackupCrypto, BACKUP_KDF_ITERATIONS, type DerivedBackupKey } from "./BackupCrypto";
import { sha256Hex } from "./hash";
import { currencyFromSettings } from "@/lib/currency";
import { encodeConfiguration, encodeNdjson } from "./Ndjson";
import type { BackupAsset, BackupKind, BackupManifest, BackupManifestFile } from "./types";

const ASSET_NAME_RE = /^assets\/images\/[A-Za-z0-9_-]+\.[A-Za-z0-9]+$/;

/** True when the ZIP entry name is one a backup may hold. Anything else is rejected before inflating. */
function isAllowedEntry(name: string): boolean {
  if (name === MANIFEST_NAME || name === DATA_NAME || name === CONFIGURATION_NAME) return true;
  if (name.startsWith("database/") && /^[a-z0-9_]+\.ndjson$/.test(name.slice("database/".length))) return true;
  if (name.startsWith("assets/images/") && /^[^/]+$/.test(name.slice("assets/images/".length)) && !name.endsWith("/")) return true;
  return false;
}

export class ArchiveCodec {
  /**
   * Builds every plaintext content file and describes it: per-file size and
   * checksum, and a checksum plus count per store. Settings are one JSON
   * document; every other store is one NDJSON file; assets are raw bytes.
   */
  static async describe(
    data: BackupData,
    now: number,
    kind: BackupKind,
    assets: BackupAsset[] = [],
  ): Promise<{ files: Map<string, Uint8Array>; manifest: BackupManifest }> {
    const files = new Map<string, Uint8Array>();
    const stores = {} as BackupManifest["stores"];
    for (const name of BACKUP_STORE_NAMES) {
      if (name === "settings") continue;
      const bytes = encodeNdjson(data[name]);
      files.set(STORE_TO_FILE[name], bytes);
      stores[name] = { count: data[name].length, sha256: await sha256Hex(bytes) };
    }
    const configBytes = encodeConfiguration(data.settings);
    files.set(CONFIGURATION_NAME, configBytes);
    stores.settings = { count: data.settings.length, sha256: await sha256Hex(configBytes) };
    const seenAssets = new Set<string>();
    for (const asset of assets) {
      if (!ASSET_NAME_RE.test(asset.name)) {
        throw new AppError("BACKUP_PACKAGE_FAILED", { details: `Asset name must look like assets/images/<id>.<ext>: ${asset.name.slice(0, 80)}` });
      }
      if (seenAssets.has(asset.name)) throw new AppError("BACKUP_PACKAGE_FAILED", { details: `Duplicate asset: ${asset.name}` });
      if (asset.bytes.length > MAX_ENTRY_BYTES) throw new AppError("BACKUP_PACKAGE_FAILED", { details: `${asset.name} is larger than the per-file limit` });
      seenAssets.add(asset.name);
      files.set(asset.name, asset.bytes);
    }
    const manifestFiles: BackupManifestFile[] = [];
    for (const [name, bytes] of [...files.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      manifestFiles.push({ name, bytes: bytes.length, sha256: await sha256Hex(bytes) });
    }
    const manifest: BackupManifest = {
      format: BACKUP_FORMAT,
      formatVersion: BACKUP_FORMAT_VERSION,
      schemaVersion: DB_SCHEMA_VERSION,
      kind,
      app: { name: APP_NAME, version: APP_VERSION },
      currency: currencyFromSettings(data.settings),
      createdAt: new Date(now).toISOString(),
      createdAtMs: now,
      stores,
      files: manifestFiles,
    };
    return { files, manifest };
  }

  /**
   * Compresses the manifest and the given files into one ZIP. When a derived
   * key is given, every content file is encrypted with it, each under its own
   * fresh IV, and the manifest records the salt and each file IV. The
   * manifest itself stays plaintext. Returns the ZIP and the final manifest.
   */
  static async pack(
    manifest: BackupManifest,
    files: Map<string, Uint8Array>,
    key?: DerivedBackupKey,
  ): Promise<{ zip: Uint8Array; manifest: BackupManifest }> {
    const mtime = new Date(manifest.createdAtMs);
    const outFiles: BackupManifestFile[] = [];
    const entries: Record<string, [Uint8Array, { level: number; mtime: Date }]> = {};
    for (const entry of manifest.files) {
      const plain = files.get(entry.name);
      if (!plain) throw new AppError("BACKUP_PACKAGE_FAILED", { details: `Missing file for the archive: ${entry.name}` });
      if (!key) {
        outFiles.push(entry);
        entries[entry.name] = [plain, { level: 9, mtime }];
        continue;
      }
      const encrypted = await BackupCrypto.encryptWithKey(plain, key.key);
      outFiles.push({ ...entry, iv: encrypted.iv });
      entries[entry.name] = [encrypted.data, { level: 9, mtime }];
    }
    const outManifest: BackupManifest = key
      ? { ...manifest, files: outFiles, encryption: { algorithm: "AES-GCM", kdf: "PBKDF2-SHA-256", iterations: BACKUP_KDF_ITERATIONS, salt: key.salt } }
      : { ...manifest, files: outFiles };
    const zip = zipSync(
      {
        [MANIFEST_NAME]: [strToU8(JSON.stringify(outManifest, null, 2)), { level: 6, mtime }],
        ...entries,
      },
      { level: 6 },
    );
    return { zip, manifest: outManifest };
  }

  /**
   * Opens a ZIP: checks the signature, allows only manifest.json, data.json
   * (format 1), database/*.ndjson, settings/configuration.json and asset
   * files, and bounds total and per-entry size before inflating.
   */
  static unpack(zip: Uint8Array): { manifestBytes: Uint8Array; files: Map<string, Uint8Array> } {
    if (zip.length > MAX_ARCHIVE_BYTES) throw new AppError("BACKUP_FILE_TOO_LARGE");
    if (zip.length < 22 || zip[0] !== 0x50 || zip[1] !== 0x4b) throw new AppError("BACKUP_NOT_ZIP", { details: "Missing ZIP signature" });
    const seen: string[] = [];
    let inflatedTotal = 0;
    let raw: Record<string, Uint8Array>;
    try {
      raw = unzipSync(zip, {
        filter: (info) => {
          seen.push(info.name);
          if (seen.length > MAX_ENTRIES) throw new AppError("BACKUP_FILE_TOO_LARGE", { details: `Archive holds more than ${MAX_ENTRIES} entries` });
          if (!isAllowedEntry(info.name)) throw new AppError("BACKUP_UNEXPECTED_CONTENT", { details: `Unexpected entry: ${info.name.slice(0, 80)}` });
          if (info.originalSize > MAX_ENTRY_BYTES) throw new AppError("BACKUP_FILE_TOO_LARGE", { details: `${info.name} expands to ${info.originalSize} bytes` });
          inflatedTotal += info.originalSize;
          if (inflatedTotal > MAX_TOTAL_INFLATED_BYTES) throw new AppError("BACKUP_FILE_TOO_LARGE", { details: `Archive expands to more than ${MAX_TOTAL_INFLATED_BYTES} bytes in total` });
          return true;
        },
      });
    } catch (e) {
      if (e instanceof AppError) throw e;
      throw new AppError("BACKUP_NOT_ZIP", { cause: e, details: e instanceof Error ? e.message : String(e) });
    }
    if (new Set(seen).size !== seen.length) throw new AppError("BACKUP_UNEXPECTED_CONTENT", { details: "Duplicate entries" });
    const manifestBytes = raw[MANIFEST_NAME];
    if (!manifestBytes) throw new AppError("BACKUP_UNEXPECTED_CONTENT", { details: `${MANIFEST_NAME} is required` });
    return { manifestBytes, files: new Map(Object.entries(raw)) };
  }

  /** Strict UTF-8 JSON parse with a clear error code. */
  static parseJson(bytes: Uint8Array, code: "BACKUP_MANIFEST_INVALID" | "BACKUP_STRUCTURE_INVALID", what: string): unknown {
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch (e) {
      throw new AppError(code, { cause: e, details: `${what} is not valid JSON: ${e instanceof Error ? e.message : String(e)}` });
    }
  }

  static text(bytes: Uint8Array): string {
    return strFromU8(bytes);
  }
}
