import { AppError } from "@/lib/errors/AppError";
import type { BackupEncryption } from "./types";

const ITERATIONS = 310_000;
/** PBKDF2 iterations used for every backup passphrase. */
export const BACKUP_KDF_ITERATIONS = ITERATIONS;
const PASSPHRASE_MIN_LENGTH = 8;

const toHex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const fromHex = (value: string) => new Uint8Array(value.match(/.{2}/g)!.map((byte) => Number.parseInt(byte, 16)));

/**
 * Encryption scheme, shared by both backup formats. A passphrase is stretched
 * once per backup with PBKDF2-HMAC-SHA-256 (310,000 iterations) and a fresh
 * 16-byte random salt into one AES-256-GCM key. Every encrypted file gets its
 * own fresh 12-byte random IV. The manifest stays plaintext and records the
 * salt plus each file IV, so decryption needs only the passphrase. Hashes and
 * counts in the manifest always refer to the plaintext bytes: decrypt first,
 * then verify. Format 1 encrypted one file with one IV stored in the
 * manifest; format 2 reuses the same derived key for every file, each with
 * its own IV recorded in that file manifest entry.
 */
export interface DerivedBackupKey {
  key: CryptoKey;
  salt: string;
}

function cryptoApi(): Crypto {
  const api = globalThis.crypto;
  if (!api?.subtle || !api.getRandomValues) throw new AppError("BACKUP_CRYPTO_UNAVAILABLE");
  return api;
}

async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const api = cryptoApi();
  const material = await api.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return api.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations: ITERATIONS },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Encrypts backup data with AES-256-GCM and a PBKDF2-derived passphrase key. */
export class BackupCrypto {
  /** Derives one key for a whole backup, with a fresh random salt. Reuse the key for every file. */
  static async createKey(passphrase: string): Promise<DerivedBackupKey> {
    if (passphrase.length < PASSPHRASE_MIN_LENGTH) throw new AppError("BACKUP_PASSWORD_TOO_SHORT");
    const api = cryptoApi();
    const salt = api.getRandomValues(new Uint8Array(16));
    const key = await deriveKey(passphrase, salt);
    return { key, salt: toHex(salt) };
  }

  /** Derives the key for a backup whose salt is already recorded in its manifest. */
  static async deriveFromSalt(passphrase: string, saltHex: string): Promise<CryptoKey> {
    return deriveKey(passphrase, fromHex(saltHex));
  }

  /** Encrypts one file with an already derived key, under a fresh random IV. */
  static async encryptWithKey(data: Uint8Array, key: CryptoKey): Promise<{ data: Uint8Array; iv: string }> {
    const api = cryptoApi();
    const iv = api.getRandomValues(new Uint8Array(12));
    const encrypted = await api.subtle.encrypt({ name: "AES-GCM", iv }, key, data as BufferSource);
    return { data: new Uint8Array(encrypted), iv: toHex(iv) };
  }

  /** Decrypts one file with an already derived key and the IV recorded for that file. */
  static async decryptWithKey(data: Uint8Array, key: CryptoKey, ivHex: string): Promise<Uint8Array> {
    try {
      const api = cryptoApi();
      const decrypted = await api.subtle.decrypt({ name: "AES-GCM", iv: fromHex(ivHex) }, key, data as BufferSource);
      return new Uint8Array(decrypted);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("BACKUP_DECRYPT_FAILED", { cause: error });
    }
  }

  static async encrypt(data: Uint8Array, passphrase: string): Promise<{ data: Uint8Array; metadata: BackupEncryption }> {
    const derived = await BackupCrypto.createKey(passphrase);
    const encrypted = await BackupCrypto.encryptWithKey(data, derived.key);
    return {
      data: encrypted.data,
      metadata: { algorithm: "AES-GCM", kdf: "PBKDF2-SHA-256", iterations: ITERATIONS, salt: derived.salt, iv: encrypted.iv },
    };
  }

  static async decrypt(data: Uint8Array, metadata: BackupEncryption, passphrase?: string): Promise<Uint8Array> {
    if (!passphrase) throw new AppError("BACKUP_PASSWORD_REQUIRED");
    if (!metadata.iv) throw new AppError("BACKUP_DECRYPT_FAILED", { details: "Manifest has no IV for the encrypted payload" });
    try {
      const key = await BackupCrypto.deriveFromSalt(passphrase, metadata.salt);
      return await BackupCrypto.decryptWithKey(data, key, metadata.iv);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("BACKUP_DECRYPT_FAILED", { cause: error });
    }
  }
}
