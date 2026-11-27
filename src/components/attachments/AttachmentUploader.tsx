"use client";

import { useRef, useState } from "react";
import { useI18n } from "@/i18n";
import { AppError } from "@/lib/errors/AppError";
import { errorCenter } from "@/lib/errors/ErrorCenter";
import { getServices } from "@/lib/domain/services";
import type { Attachment, AttachmentEntityType } from "@/lib/domain/attachments";
import { AttachmentRejection, prepareImageFile, type PreparedAttachment } from "@/lib/attachments/compress";
import { Button } from "../ui/Button";

interface Props {
  entityType: AttachmentEntityType;
  entityId: string | null;
  onStored?: (attachment: Attachment) => void;
  onPending?: (prepared: PreparedAttachment) => void;
  disabled?: boolean;
}

/** Image picker: validates and shrinks each file on the device, then stores it or hands it back as pending. Failures are shown inline and reported, never silent. */
export function AttachmentUploader({ entityType, entityId, onStored, onPending, disabled = false }: Props) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setBusy(true);
    setError("");
    let firstMessage = "";
    for (const file of Array.from(files)) {
      try {
        const prepared = await prepareImageFile(file, file.name);
        if (entityId) {
          const stored = await getServices().attachments.add({ entityType, entityId, prepared });
          onStored?.(stored);
        } else {
          onPending?.(prepared);
        }
      } catch (e) {
        if (e instanceof AttachmentRejection) {
          const message = t(e.key, e.vars);
          if (!firstMessage) firstMessage = message;
          errorCenter.report(new AppError("VALIDATION", { details: message }), { action: "attachment.add" });
        } else {
          const appError = AppError.from(e);
          if (!firstMessage) firstMessage = t("error.generic");
          errorCenter.report(appError, { action: "attachment.add" });
        }
      }
    }
    if (firstMessage) setError(firstMessage);
    setBusy(false);
    if (inputRef.current) inputRef.current.value = "";
  }

  return (
    <div className="flex flex-col gap-2">
      <div>
        <input
          ref={inputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/gif"
          multiple
          disabled={disabled || busy}
          aria-label={t("attachment.add")}
          className="sr-only"
          onChange={(e) => void handleFiles(e.target.files)}
        />
        <Button
          variant="soft"
          icon="upload"
          disabled={disabled || busy}
          className="max-sm:min-h-11"
          onClick={() => inputRef.current?.click()}
        >
          {t("attachment.add")}
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
