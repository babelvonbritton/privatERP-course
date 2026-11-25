import { ValidationError } from "./Guard";
import { LIMITS, ORG_ID, OWNER_ID, type Actor } from "@/lib/domain/types";
import type { SettingsStore } from "./repositories";

/** The business profile: the single record that identifies the business on invoices and in record stamps. */
export interface BusinessProfile {
  /** Shown on invoices and used as the organization id of new records. Empty until the user sets it. */
  businessName: string;
  /** Used as the owner id of new records. Never shown on an invoice. */
  ownerName: string;
  /** Shown on invoices, under the business name block. */
  address: string;
  /** Contact lines shown on invoices, one per line. */
  contacts: string[];
  /** Shown on invoices directly below the business name. */
  tagline: string;
  /** Attachment id of the uploaded logo, or null when no logo was uploaded. The bytes live in the attachment blob store, never in a setting. */
  logoAttachmentId: string | null;
}

export const DEFAULT_BUSINESS_PROFILE: BusinessProfile = { businessName: "", ownerName: "", address: "", contacts: [], tagline: "", logoAttachmentId: null };

/** Entity id the single business logo is stored under in the attachment store. */
export const PROFILE_ENTITY_ID = "profile";

/** Most contact lines the form keeps. */
export const MAX_CONTACTS = 10;
/** Longest address the form keeps. */
export const MAX_ADDRESS_LENGTH = 500;

const KEYS: Record<keyof BusinessProfile, string> = {
  businessName: "profile.businessName",
  ownerName: "profile.ownerName",
  address: "profile.address",
  contacts: "profile.contacts",
  tagline: "profile.tagline",
  logoAttachmentId: "profile.logoAttachmentId",
};

type Stored = string | number | boolean | null | undefined;

function isText(value: Stored, maxLength: number): value is string {
  return typeof value === "string" && value.length <= maxLength;
}

function readContacts(value: Stored): string[] | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.length > MAX_CONTACTS) return undefined;
    if (parsed.some((item) => typeof item !== "string" || item.length === 0 || item.length > LIMITS.phone)) return undefined;
    return [...parsed];
  } catch {
    return undefined;
  }
}

/** A reader returns the stored value, or undefined when it is not allowed. Undefined (not null) marks invalid, because a null logo id is a valid value. */
const READERS: { [K in keyof BusinessProfile]: (v: Stored) => BusinessProfile[K] | undefined } = {
  businessName: (v) => (isText(v, LIMITS.name) ? v : undefined),
  ownerName: (v) => (isText(v, LIMITS.name) ? v : undefined),
  address: (v) => (isText(v, MAX_ADDRESS_LENGTH) ? v : undefined),
  contacts: readContacts,
  tagline: (v) => (isText(v, LIMITS.lineDescription) ? v : undefined),
  logoAttachmentId: (v) => (v === null || typeof v === "string" ? v : undefined),
};

/** The actor new records are stamped with, derived from the profile: the business name is the organization id, the owner's name is the owner id, and the built-in constants stay as the fallback while a field is empty. */
export function actorForProfile(profile: BusinessProfile): Actor {
  return {
    id: profile.ownerName.trim() || OWNER_ID,
    orgId: profile.businessName.trim() || ORG_ID,
    role: "owner",
  };
}

/**
 * Typed business profile stored in the settings store, one key per field like
 * the preferences. The profile rides in the NDJSON backup with the rest of
 * the settings; the logo bytes ride as an attachment asset, never as JSON.
 */
export class BusinessProfileService {
  private current: BusinessProfile = structuredClone(DEFAULT_BUSINESS_PROFILE);

  constructor(private readonly settings: SettingsStore) {}

  /** Loads the profile. `repaired` lists keys whose stored value was not allowed and was reset. */
  async load(): Promise<{ profile: BusinessProfile; repaired: string[] }> {
    const rows = new Map((await this.settings.all()).map((r) => [r.key, r.value] as const));
    const next = structuredClone(DEFAULT_BUSINESS_PROFILE) as unknown as Record<string, unknown>;
    const repaired: string[] = [];
    for (const name of Object.keys(KEYS) as Array<keyof BusinessProfile>) {
      if (!rows.has(KEYS[name])) continue;
      const value = READERS[name](rows.get(KEYS[name]));
      if (value === undefined) {
        repaired.push(KEYS[name]);
        await this.set(name, DEFAULT_BUSINESS_PROFILE[name]);
      } else next[name] = value;
    }
    this.current = next as unknown as BusinessProfile;
    return { profile: this.get(), repaired };
  }

  get(): BusinessProfile {
    return { ...this.current, contacts: [...this.current.contacts] };
  }

  /** Validates and saves the whole profile. */
  async save(profile: BusinessProfile): Promise<BusinessProfile> {
    const cleaned: BusinessProfile = {
      businessName: profile.businessName.trim(),
      ownerName: profile.ownerName.trim(),
      address: profile.address.trim(),
      contacts: profile.contacts.map((c) => c.trim()).filter((c) => c.length > 0),
      tagline: profile.tagline.trim(),
      logoAttachmentId: profile.logoAttachmentId,
    };
    if (READERS.businessName(cleaned.businessName) === undefined) throw new ValidationError("businessName", "business name is too long", "invalid");
    if (READERS.ownerName(cleaned.ownerName) === undefined) throw new ValidationError("ownerName", "owner name is too long", "invalid");
    if (READERS.address(cleaned.address) === undefined) throw new ValidationError("address", "address is too long", "invalid");
    if (cleaned.contacts.length > MAX_CONTACTS || cleaned.contacts.some((c) => c.length > LIMITS.phone)) {
      throw new ValidationError("contacts", "too many contacts or a contact is too long", "invalid");
    }
    if (READERS.tagline(cleaned.tagline) === undefined) throw new ValidationError("tagline", "tagline is too long", "invalid");
    if (cleaned.logoAttachmentId !== null && typeof cleaned.logoAttachmentId !== "string") {
      throw new ValidationError("logoAttachmentId", "logo is not a stored attachment", "invalid");
    }
    await this.settings.write(KEYS.businessName, cleaned.businessName);
    await this.settings.write(KEYS.ownerName, cleaned.ownerName);
    await this.settings.write(KEYS.address, cleaned.address);
    await this.settings.write(KEYS.contacts, JSON.stringify(cleaned.contacts));
    await this.settings.write(KEYS.tagline, cleaned.tagline);
    await this.settings.write(KEYS.logoAttachmentId, cleaned.logoAttachmentId);
    this.current = { ...cleaned, contacts: [...cleaned.contacts] };
    return this.get();
  }

  /** Validates and saves one field, for writers that update the profile directly. */
  async set<K extends keyof BusinessProfile>(name: K, value: BusinessProfile[K]): Promise<BusinessProfile> {
    // Contacts are validated in their stored form (a JSON string), like every other field.
    const stored = name === "contacts" ? JSON.stringify(value) : (value as string | null);
    if (READERS[name](stored as Stored) === undefined) throw new ValidationError(`profile ${name}`, `${name} is not an allowed value`, "invalid");
    await this.settings.write(KEYS[name], stored);
    this.current = { ...this.current, [name]: value };
    return this.get();
  }
}
