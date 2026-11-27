"use client";

import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/i18n";
import { AttachmentRejection, prepareImageFile, type PreparedAttachment } from "@/lib/attachments/compress";
import { applyBusinessProfile, getServices } from "@/lib/domain/services";
import { errorCenter } from "@/lib/errors/ErrorCenter";
import { useLoadOnce } from "@/lib/hooks/useLoadOnce";
import { DEFAULT_BUSINESS_PROFILE, MAX_CONTACTS, PROFILE_ENTITY_ID, type BusinessProfile } from "@/lib/storage/BusinessProfileService";
import { getStorage } from "@/lib/storage";
import { LIMITS } from "@/lib/domain/types";
import { Button } from "../ui/Button";
import { Field, inputClass } from "../ui/Field";
import { Icon } from "../ui/Icon";
import { TagInput } from "../ui/TagInput";

/**
 * The business profile form, used both in Settings and in the dashboard's
 * quick-setup dialog. The business name is the only required field; the
 * logo is uploaded only when the form is saved, so closing without saving
 * leaves nothing behind. The name error appears only after a save attempt,
 * never while the user is still typing.
 */
export function BusinessProfileForm({ onSaved }: { onSaved?: (profile: BusinessProfile) => void }) {
  const { t } = useI18n();
  const [profile, setProfile] = useState<BusinessProfile>(DEFAULT_BUSINESS_PROFILE);
  const [loaded, setLoaded] = useState(false);
  const [businessName, setBusinessName] = useState("");
  const [ownerName, setOwnerName] = useState("");
  const [address, setAddress] = useState("");
  const [contacts, setContacts] = useState<string[]>([]);
  const [tagline, setTagline] = useState("");
  const [storedLogoUrl, setStoredLogoUrl] = useState<string | null>(null);
  const [pendingLogo, setPendingLogo] = useState<PreparedAttachment | null>(null);
  const [pendingLogoUrl, setPendingLogoUrl] = useState<string | null>(null);
  const [logoRemoved, setLogoRemoved] = useState(false);
  const [nameError, setNameError] = useState(false);
  const [logoError, setLogoError] = useState("");
  const [saving, setSaving] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useLoadOnce(async (alive) => {
    const urls: string[] = [];
    try {
      const { profile: stored } = await getStorage().profile.load();
      if (!alive()) return;
      setProfile(stored);
      setBusinessName(stored.businessName);
      setOwnerName(stored.ownerName);
      setAddress(stored.address);
      setContacts(stored.contacts);
      setTagline(stored.tagline);
      if (stored.logoAttachmentId) {
        const blob = await getServices().attachments.getBlob(stored.logoAttachmentId);
        if (alive() && blob) {
          const url = URL.createObjectURL(blob);
          urls.push(url);
          setStoredLogoUrl(url);
        }
      }
    } finally {
      if (alive()) setLoaded(true);
    }
    return () => {
      for (const url of urls) URL.revokeObjectURL(url);
    };
  }, "profile.load");

  useEffect(() => {
    if (!pendingLogo) return;
    const url = URL.createObjectURL(pendingLogo.blob);
    setPendingLogoUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [pendingLogo]);

  const logoUrl = pendingLogoUrl ?? (logoRemoved ? null : storedLogoUrl);

  async function pickLogo(file: File | undefined): Promise<void> {
    if (!file) return;
    setLogoError("");
    try {
      setPendingLogo(await prepareImageFile(file, file.name));
      setLogoRemoved(false);
    } catch (e) {
      if (e instanceof AttachmentRejection) setLogoError(t(e.key, e.vars));
      else errorCenter.report(e, { action: "profile.logo" });
    }
  }

  function removeLogo(): void {
    setPendingLogo(null);
    setPendingLogoUrl(null);
    setLogoRemoved(true);
    setLogoError("");
  }

  async function save(): Promise<void> {
    if (saving) return;
    if (businessName.trim() === "") {
      setNameError(true);
      nameRef.current?.focus();
      return;
    }
    setSaving(true);
    try {
      const services = getServices();
      let logoAttachmentId = profile.logoAttachmentId;
      if (pendingLogo) {
        const stored = await services.attachments.add({ entityType: "profile", entityId: PROFILE_ENTITY_ID, prepared: pendingLogo });
        if (logoAttachmentId && logoAttachmentId !== stored.id) {
          await services.attachments.remove(logoAttachmentId).catch(() => {});
        }
        logoAttachmentId = stored.id;
      } else if (logoRemoved && logoAttachmentId) {
        await services.attachments.remove(logoAttachmentId).catch(() => {});
        logoAttachmentId = null;
      }
      const saved = await getStorage().profile.save({
        businessName,
        ownerName,
        address,
        contacts,
        tagline,
        logoAttachmentId,
      });
      setProfile(saved);
      setPendingLogo(null);
      setPendingLogoUrl(null);
      setLogoRemoved(false);
      if (logoAttachmentId) {
        const blob = await services.attachments.getBlob(logoAttachmentId);
        if (blob) setStoredLogoUrl(URL.createObjectURL(blob));
      } else {
        setStoredLogoUrl(null);
      }
      applyBusinessProfile(saved);
      errorCenter.notify({ key: "toast.saved" });
      onSaved?.(saved);
    } catch (e) {
      errorCenter.report(e, { action: "profile.save" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-4">
        <div className="grid size-20 shrink-0 place-items-center overflow-hidden rounded-card border border-line bg-canvas text-muted">
          {logoUrl ? (
            <img src={logoUrl} alt="" className="size-full object-contain" />
          ) : (
            <Icon name="building" size={36} />
          )}
        </div>
        <div className="flex min-w-0 flex-col gap-2">
          <p className="text-sm font-medium text-ink">{t("profile.logo")}</p>
          <p className="text-sm text-muted">{t("profile.logoHint")}</p>
          <div className="flex flex-wrap gap-2">
            <input
              ref={fileRef}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif"
              className="sr-only"
              aria-label={t("profile.uploadLogo")}
              onChange={(e) => {
                void pickLogo(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
            <Button type="button" variant="soft" className="max-sm:min-h-11" onClick={() => fileRef.current?.click()}>
              {logoUrl ? t("profile.changeLogo") : t("profile.uploadLogo")}
            </Button>
            {logoUrl && (
              <Button type="button" variant="ghost" className="max-sm:min-h-11" onClick={removeLogo}>
                {t("profile.removeLogo")}
              </Button>
            )}
          </div>
          {logoError && (
            <p role="alert" className="text-sm text-danger">
              {logoError}
            </p>
          )}
        </div>
      </div>

      <Field label={t("profile.businessName")} htmlFor="profile-business-name" hint={t("profile.businessNameHint")}>
        <input
          ref={nameRef}
          id="profile-business-name"
          type="text"
          value={businessName}
          maxLength={LIMITS.name}
          autoComplete="organization"
          aria-invalid={nameError ? "true" : "false"}
          aria-describedby={nameError ? "profile-business-name-error" : undefined}
          onChange={(e) => {
            setBusinessName(e.target.value);
            if (nameError) setNameError(false);
          }}
          placeholder={t("profile.businessNamePlaceholder")}
          className={`${inputClass} h-11 px-3`}
        />
        {nameError && (
          <p id="profile-business-name-error" role="alert" className="text-sm text-danger">
            {t("profile.nameRequired")}
          </p>
        )}
      </Field>

      <Field label={t("profile.ownerName")} htmlFor="profile-owner-name" hint={t("profile.ownerNameHint")}>
        <input
          id="profile-owner-name"
          type="text"
          value={ownerName}
          maxLength={LIMITS.name}
          autoComplete="name"
          onChange={(e) => setOwnerName(e.target.value)}
          placeholder={t("profile.ownerNamePlaceholder")}
          className={`${inputClass} h-11 px-3`}
        />
      </Field>

      <Field label={t("profile.address")} htmlFor="profile-address">
        <textarea
          id="profile-address"
          value={address}
          maxLength={500}
          rows={3}
          autoComplete="street-address"
          onChange={(e) => setAddress(e.target.value)}
          placeholder={t("profile.addressPlaceholder")}
          className={`${inputClass} px-3 py-2.5`}
        />
      </Field>

      <Field label={t("profile.contacts")} htmlFor="profile-contacts" hint={t("profile.contactsHint")}>
        <TagInput id="profile-contacts" value={contacts} onChange={setContacts} suggestions={[]} placeholder={t("profile.contactsPlaceholder")} maxItems={MAX_CONTACTS} />
      </Field>

      <Field label={t("profile.tagline")} htmlFor="profile-tagline">
        <input
          id="profile-tagline"
          type="text"
          value={tagline}
          maxLength={LIMITS.lineDescription}
          onChange={(e) => setTagline(e.target.value)}
          placeholder={t("profile.taglinePlaceholder")}
          className={`${inputClass} h-11 px-3`}
        />
      </Field>

      <div className="flex justify-end">
        <Button type="button" disabled={!loaded || saving} className="max-sm:min-h-11" onClick={() => void save()}>
          {t("action.save")}
        </Button>
      </div>
    </div>
  );
}
