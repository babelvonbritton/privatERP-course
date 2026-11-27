import { ValidationError } from "./Guard";
import { isCurrencyCode, type CurrencyCode } from "@/lib/domain/types";
import { DEFAULT_TRASH_RETENTION_DAYS, type TrashRetentionDays } from "@/lib/domain/trash";
import { deviceTimezone, isTimezone } from "@/lib/timezone";
import type { SettingsStore } from "./repositories";

export interface Preferences {
  tourSeen: boolean;
  currency: CurrencyCode;
  currencySwitchDate: string;
  currencySwitchCount: number;
  trashRetentionDays: TrashRetentionDays;
  timezone: string;
}

const DEFAULT_PREFERENCES: Preferences = { tourSeen: false, currency: "IDR", currencySwitchDate: "", currencySwitchCount: 0, trashRetentionDays: DEFAULT_TRASH_RETENTION_DAYS, timezone: deviceTimezone() };

const KEYS: Record<keyof Preferences, string> = {
  tourSeen: "pref.tourSeen",
  currency: "pref.currency",
  currencySwitchDate: "pref.currencySwitchDate",
  currencySwitchCount: "pref.currencySwitchCount",
  trashRetentionDays: "pref.trashRetentionDays",
  timezone: "pref.timezone",
};

export const PREFERENCE_KEYS: Record<keyof Preferences, string> = KEYS;

type Stored = string | number | boolean | null | undefined;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const READERS: { [K in keyof Preferences]: (v: Stored) => Preferences[K] | null } = {
  tourSeen: (v) => (typeof v === "boolean" ? v : null),
  currency: (v) => (isCurrencyCode(v) ? v : null),
  currencySwitchDate: (v) => (typeof v === "string" && (v === "" || DATE_RE.test(v)) ? v : null),
  currencySwitchCount: (v) => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= 10_000 ? v : null),
  trashRetentionDays: (v) => (v === 7 || v === 30 ? v : null),
  timezone: (v) => (isTimezone(v) ? v : null),
};

export class PreferenceService {
  private current: Preferences = structuredClone(DEFAULT_PREFERENCES);

  constructor(private readonly settings: SettingsStore) {}

  /** Loads preferences. `repaired` lists keys whose stored value was not allowed and was reset. */
  async load(): Promise<{ preferences: Preferences; repaired: string[] }> {
    const rows = new Map((await this.settings.all()).map((r) => [r.key, r.value] as const));
    const next = structuredClone(DEFAULT_PREFERENCES) as unknown as Record<string, unknown>;
    const repaired: string[] = [];
    for (const name of Object.keys(KEYS) as Array<keyof Preferences>) {
      if (!rows.has(KEYS[name])) continue;
      const value = READERS[name](rows.get(KEYS[name]));
      if (value === null) {
        repaired.push(KEYS[name]);
        await this.set(name, DEFAULT_PREFERENCES[name]);
      } else next[name] = value;
    }
    this.current = next as unknown as Preferences;
    return { preferences: this.get(), repaired };
  }

  get(): Preferences {
    return { ...this.current };
  }

  /** Validates and saves one preference. */
  async set<K extends keyof Preferences>(name: K, value: Preferences[K]): Promise<Preferences> {
    if (READERS[name](value as Stored) === null) throw new ValidationError(`preference ${name}`, `${name} is not an allowed value`, "invalid");
    await this.settings.write(KEYS[name], value as string | number | boolean);
    this.current = { ...this.current, [name]: value };
    return this.get();
  }
}
