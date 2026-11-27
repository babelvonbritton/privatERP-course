import { strToU8 } from "fflate";
import { AppError } from "@/lib/errors/AppError";

/**
 * One JSON object per line, each line ending with a newline. An empty store
 * encodes to zero bytes, so an empty file and a missing file stay distinct.
 */
export function encodeNdjson(records: readonly unknown[]): Uint8Array {
  if (records.length === 0) return new Uint8Array(0);
  return strToU8(`${records.map((r) => JSON.stringify(r)).join("\n")}\n`);
}

interface NdjsonDecodeResult {
  records: unknown[];
  badLines: number;
}

/**
 * Decodes NDJSON, skipping invalid lines and counting them. A file that is
 * not valid UTF-8 at all fails outright, because none of its lines can be trusted.
 */
export function decodeNdjson(bytes: Uint8Array, fileName: string): NdjsonDecodeResult {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (e) {
    throw new AppError("BACKUP_STRUCTURE_INVALID", { cause: e, details: `${fileName} is not valid UTF-8` });
  }
  const records: unknown[] = [];
  let badLines = 0;
  for (const line of text.split("\n")) {
    if (line === "") continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      badLines++;
    }
  }
  return { records, badLines };
}

/** Settings travel as one JSON document: an object holding the settings list. */
export function encodeConfiguration(settings: readonly unknown[]): Uint8Array {
  return strToU8(JSON.stringify({ settings }, null, 2));
}

export function decodeConfiguration(bytes: Uint8Array): unknown[] {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (e) {
    throw new AppError("BACKUP_STRUCTURE_INVALID", { cause: e, details: `settings/configuration.json is not valid JSON: ${e instanceof Error ? e.message : String(e)}` });
  }
  if (typeof raw !== "object" || raw === null || !Array.isArray((raw as Record<string, unknown>).settings)) {
    throw new AppError("BACKUP_STRUCTURE_INVALID", { details: "settings/configuration.json must hold a settings list" });
  }
  return (raw as { settings: unknown[] }).settings;
}
