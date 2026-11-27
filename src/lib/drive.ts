import { AppError } from "@/lib/errors/AppError";
import { isAlphanumericPassphrase } from "@/lib/backup/BackupCrypto";
import type { BackupData, SettingRecord } from "@/lib/domain/types";
import type { SettingsStore } from "@/lib/storage/repositories";

export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.appdata";
export const DRIVE_BACKUP_FILENAME = "olaseena-backup.olaseena";
export const DRIVE_PASSPHRASE_FILENAME = "olaseena-drive-passphrase.json";

export type SetupPassphraseError = "required" | "alphanumeric" | "mismatch";

export function setupPassphraseError(passphrase: string, confirm: string): SetupPassphraseError | null {
  if (passphrase === "" || confirm === "") return "required";
  if (!isAlphanumericPassphrase(passphrase) || !isAlphanumericPassphrase(confirm)) return "alphanumeric";
  if (passphrase !== confirm) return "mismatch";
  return null;
}

/** Contents of the passphrase download: the passphrase plus enough metadata to tell what the file is. The passphrase is readable in the file, by design. The file is the recovery path. */
export function buildDrivePassphraseFile(passphrase: string, now = new Date()): string {
  return JSON.stringify(
    {
      app: "Olaseena",
      type: "drive-backup-passphrase",
      passphrase,
      createdAt: now.toISOString(),
    },
    null,
    2,
  );
}

export const DEFAULT_DRIVE_CLIENT_ID =
  "452644187427-04bbl0hf732503fuhic7phbcs92qm7on.apps.googleusercontent.com";

/**
 * The Client ID a sign-in actually uses: the user's own override when one
 * is saved, otherwise the shared default, otherwise null (no sign-in is
 * possible until a Client ID is provided one way or the other).
 */
export function resolveDriveClientId(
  override: string | null | undefined,
  shared: string = DEFAULT_DRIVE_CLIENT_ID,
): string | null {
  const own = override?.trim();
  if (own) return own;
  const fallback = shared.trim();
  return fallback ? fallback : null;
}

const GIS_SCRIPT = "https://accounts.google.com/gsi/client";

interface TokenResponse {
  access_token: string;
  expires_in: number;
}

interface TokenClient {
  requestAccessToken: (opts: { prompt?: string }) => void;
}

interface GisOauth2 {
  initTokenClient: (config: {
    client_id: string;
    scope: string;
    callback: (res: TokenResponse) => void;
    error_callback?: (err: unknown) => void;
  }) => TokenClient;
}

interface GisLike {
  accounts: { oauth2: GisOauth2 };
}

type GisLoader = () => Promise<GisLike>;

let gisPromise: Promise<GisLike> | null = null;

/** Loads the Google sign-in library on first use only, so a signed-out app makes no Google requests at all. */
function defaultGisLoader(): Promise<GisLike> {
  if (gisPromise) return gisPromise;
  gisPromise = new Promise<GisLike>((resolve, reject) => {
    const existing = document.querySelector(
      `script[src="${GIS_SCRIPT}"]`,
    ) as HTMLScriptElement | null;
    if (existing) {
      if ((window as unknown as { google?: GisLike }).google?.accounts?.oauth2) {
        resolve((window as unknown as { google: GisLike }).google);
        return;
      }
      existing.addEventListener("load", () => resolveGis(resolve, reject));
      existing.addEventListener("error", () =>
        reject(new AppError("DRIVE_GIS_FAILED")),
      );
      return;
    }
    const script = document.createElement("script");
    script.src = GIS_SCRIPT;
    script.async = true;
    script.defer = true;
    script.onload = () => resolveGis(resolve, reject);
    script.onerror = () => reject(new AppError("DRIVE_GIS_FAILED"));
    document.head.appendChild(script);
  });
  return gisPromise;
}

function resolveGis(
  resolve: (gis: GisLike) => void,
  reject: (err: AppError) => void,
): void {
  const google = (window as unknown as { google?: GisLike }).google;
  if (google?.accounts?.oauth2) resolve(google);
  else reject(new AppError("DRIVE_GIS_FAILED"));
}

export interface DriveToken {
  accessToken: string;
  expiresAt: number;
}

export interface DriveBackupInfo {
  id: string;
  name: string;
  modifiedTime: string;
  size?: string;
}

export class DriveService {
  private loadGis: GisLoader;
  private fetchFn: typeof fetch;

  constructor(
    loadGis: GisLoader = defaultGisLoader,
    fetchFn: typeof fetch = fetch,
  ) {
    this.loadGis = loadGis;
    this.fetchFn = (...args: Parameters<typeof fetch>) => fetchFn(...args);
  }

  private async requestToken(
    clientId: string,
    prompt: "" | "consent",
  ): Promise<DriveToken> {
    let gis: GisLike;
    try {
      gis = await this.loadGis();
    } catch {
      throw new AppError("DRIVE_GIS_FAILED");
    }
    return new Promise<DriveToken>((resolve, reject) => {
      const client = gis.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope: DRIVE_SCOPE,
        callback: (res) => {
          if (!res.access_token) {
            reject(new AppError("DRIVE_GIS_FAILED"));
            return;
          }
          const expiresAt = Date.now() + res.expires_in * 1000 - 60_000;
          resolve({ accessToken: res.access_token, expiresAt });
        },
        error_callback: () => {
          reject(new AppError("DRIVE_GIS_FAILED"));
        },
      });
      client.requestAccessToken({ prompt });
    });
  }

  /** First connect: shows the Google consent screen. */
  connect(clientId: string): Promise<DriveToken> {
    return this.requestToken(clientId, "consent");
  }

  /** Silent refresh while the grant is still valid; null when it is not. */
  async refresh(clientId: string): Promise<DriveToken | null> {
    try {
      return await this.requestToken(clientId, "");
    } catch {
      return null;
    }
  }

  private async authorized(
    token: string,
    path: string,
    init: RequestInit,
  ): Promise<Response> {
    const res = await this.fetchFn(path, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        Authorization: `Bearer ${token}`,
      },
    });
    if (res.status === 401 || res.status === 403) throw new AppError("DRIVE_AUTH");
    return res;
  }

  /** The backup file in the app folder, newest first. */
  async listBackups(token: string): Promise<DriveBackupInfo[]> {
    const q = encodeURIComponent(
      `name='${DRIVE_BACKUP_FILENAME}' and 'appDataFolder' in parents and trashed=false`,
    );
    const res = await this.authorized(
      token,
      `https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${q}&fields=files(id,name,modifiedTime,size)&orderBy=modifiedTime desc`,
      { method: "GET" },
    );
    if (!res.ok) throw new AppError("DRIVE_LIST_FAILED");
    const data = (await res.json()) as { files?: DriveBackupInfo[] };
    return data.files ?? [];
  }

  /**
   * Uploads the encrypted backup bytes. Updates the existing file when one
   * is already there, so the folder never fills with duplicates.
   */
  async uploadBackup(
    token: string,
    bytes: Uint8Array,
    existingId: string | null,
  ): Promise<{ id: string; modifiedTime: string }> {
    const boundary = `olaseena-${Date.now().toString(36)}`;
    const metadata = JSON.stringify({
      name: DRIVE_BACKUP_FILENAME,
      parents: existingId ? undefined : ["appDataFolder"],
    });
    const head = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`;
    const tail = `\r\n--${boundary}--`;
    const body = new Blob(
      [head, bytes as BlobPart, tail],
      { type: `multipart/related; boundary=${boundary}` },
    );
    const url = existingId
      ? `https://www.googleapis.com/upload/drive/v3/files/${existingId}?uploadType=multipart`
      : "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart";
    const res = await this.authorized(token, url, {
      method: existingId ? "PATCH" : "POST",
      body,
    });
    if (!res.ok) throw new AppError("DRIVE_UPLOAD_FAILED");
    const data = (await res.json()) as { id: string; modifiedTime: string };
    return { id: data.id, modifiedTime: data.modifiedTime };
  }

  /** Downloads the encrypted backup bytes of one file. */
  async downloadBackup(token: string, fileId: string): Promise<Uint8Array> {
    const res = await this.authorized(
      token,
      `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
      { method: "GET" },
    );
    if (!res.ok) throw new AppError("DRIVE_DOWNLOAD_FAILED");
    return new Uint8Array(await res.arrayBuffer());
  }
}


export const DRIVE_SETTING_KEYS = {
  clientId: "drive.clientId",
  accessToken: "drive.accessToken",
  tokenExpiresAt: "drive.tokenExpiresAt",
  lastBackupAt: "drive.lastBackupAt",
  syncEnabled: "drive.syncEnabled",
  lastSyncedAt: "drive.lastSyncedAt",
  passphrase: "drive.passphrase",
  dirty: "drive.dirty",
} as const;

export const DRIVE_BACKUP_EXCLUDED_KEYS = new Set<string>([
  DRIVE_SETTING_KEYS.accessToken,
  DRIVE_SETTING_KEYS.tokenExpiresAt,
  DRIVE_SETTING_KEYS.passphrase,
  DRIVE_SETTING_KEYS.lastBackupAt,
  DRIVE_SETTING_KEYS.lastSyncedAt,
  DRIVE_SETTING_KEYS.dirty,
]);

export interface DriveState {
  clientId: string | null;
  accessToken: string | null;
  tokenExpiresAt: number | null;
  lastBackupAt: number | null;
  syncEnabled: boolean;
  lastSyncedAt: number | null;
  passphrase: string | null;
  dirty: boolean;
}

export const DEFAULT_DRIVE_STATE: DriveState = {
  clientId: null,
  accessToken: null,
  tokenExpiresAt: null,
  lastBackupAt: null,
  syncEnabled: false,
  lastSyncedAt: null,
  passphrase: null,
  dirty: false,
};

/** Reads the Drive state from the settings store. Missing keys fall back to their defaults. */
export async function readDriveState(settings: SettingsStore): Promise<DriveState> {
  const rows = new Map((await settings.all()).map((r) => [r.key, r.value] as const));
  const read = <T extends SettingRecord["value"],>(key: string, fallback: T, check: (v: SettingRecord["value"]) => v is T): T => {
    const v = rows.get(key);
    return v !== undefined && check(v) ? v : fallback;
  };
  const isString = (v: SettingRecord["value"]): v is string => typeof v === "string";
  const isNumber = (v: SettingRecord["value"]): v is number => typeof v === "number" && Number.isFinite(v);
  const isBoolean = (v: SettingRecord["value"]): v is boolean => typeof v === "boolean";
  return {
    clientId: read<string | null>(DRIVE_SETTING_KEYS.clientId, null, (v): v is string | null => v === null || isString(v)),
    accessToken: read<string | null>(DRIVE_SETTING_KEYS.accessToken, null, (v): v is string | null => v === null || isString(v)),
    tokenExpiresAt: read<number | null>(DRIVE_SETTING_KEYS.tokenExpiresAt, null, (v): v is number | null => v === null || isNumber(v)),
    lastBackupAt: read<number | null>(DRIVE_SETTING_KEYS.lastBackupAt, null, (v): v is number | null => v === null || isNumber(v)),
    syncEnabled: read<boolean>(DRIVE_SETTING_KEYS.syncEnabled, false, isBoolean),
    lastSyncedAt: read<number | null>(DRIVE_SETTING_KEYS.lastSyncedAt, null, (v): v is number | null => v === null || isNumber(v)),
    passphrase: read<string | null>(DRIVE_SETTING_KEYS.passphrase, null, (v): v is string | null => v === null || isString(v)),
    dirty: read<boolean>(DRIVE_SETTING_KEYS.dirty, false, isBoolean),
  };
}

/** Writes the given Drive state fields to the settings store. Only the fields present in the patch are written. */
export async function writeDriveState(
  settings: SettingsStore,
  patch: Partial<DriveState>,
): Promise<void> {
  const entries: Array<[string, SettingRecord["value"]]> = [];
  if (patch.clientId !== undefined) entries.push([DRIVE_SETTING_KEYS.clientId, patch.clientId]);
  if (patch.accessToken !== undefined) entries.push([DRIVE_SETTING_KEYS.accessToken, patch.accessToken]);
  if (patch.tokenExpiresAt !== undefined) entries.push([DRIVE_SETTING_KEYS.tokenExpiresAt, patch.tokenExpiresAt]);
  if (patch.lastBackupAt !== undefined) entries.push([DRIVE_SETTING_KEYS.lastBackupAt, patch.lastBackupAt]);
  if (patch.syncEnabled !== undefined) entries.push([DRIVE_SETTING_KEYS.syncEnabled, patch.syncEnabled]);
  if (patch.lastSyncedAt !== undefined) entries.push([DRIVE_SETTING_KEYS.lastSyncedAt, patch.lastSyncedAt]);
  if (patch.passphrase !== undefined) entries.push([DRIVE_SETTING_KEYS.passphrase, patch.passphrase]);
  if (patch.dirty !== undefined) entries.push([DRIVE_SETTING_KEYS.dirty, patch.dirty]);
  for (const [key, value] of entries) await settings.write(key, value);
}

/** Returns backup data with the Drive secrets and device state removed from the settings, so a backup never carries its own unlock key or the device's access token. */
export function stripDriveSecrets(data: BackupData): BackupData {
  return {
    ...data,
    settings: data.settings.filter((s) => !DRIVE_BACKUP_EXCLUDED_KEYS.has(s.key)),
  };
}

/**
 * Returns a usable access token: the stored one while it is still valid,
 * otherwise a silent refresh (the fresh token is saved through `persist`).
 * Returns null when there is no token or the grant is gone. The user has
 * to connect again. Never throws: a failed refresh is a null, not an error.
 */
export async function ensureDriveToken(
  drive: DriveService,
  state: DriveState,
  persist: (token: DriveToken) => Promise<void>,
): Promise<string | null> {
  if (state.accessToken && state.tokenExpiresAt && state.tokenExpiresAt > Date.now()) {
    return state.accessToken;
  }
  const clientId = resolveDriveClientId(state.clientId);
  if (!clientId) return null;
  const refreshed = await drive.refresh(clientId);
  if (!refreshed) return null;
  await persist(refreshed);
  return refreshed.accessToken;
}
