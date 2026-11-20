"use client";

import { useEffect, useMemo } from "react";
import { useI18n } from "@/i18n";
import { Icon } from "../ui/Icon";

/** One thumbnail row: a stored file (blob may be null when the file is missing) or a pending file. */
export interface ThumbSource {
  key: string;
  fileName: string;
  sizeBytes: number;
  blob: Blob | null;
}

interface Props {
  items: ThumbSource[];
  /** Omitted when the thumbnails cannot be opened, for example files picked while creating that are not stored yet. */
  onOpen?: (item: ThumbSource) => void;
  onRemove: (item: ThumbSource) => void;
}

/** Formats a byte count the way the rest of the app shows sizes. */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Grid of image thumbnails. Object URLs are created here and revoked when the list changes. */
export function AttachmentThumbnails({ items, onOpen, onRemove }: Props) {
  const { t } = useI18n();

  const urls = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of items) {
      if (item.blob) map.set(item.key, URL.createObjectURL(item.blob));
    }
    return map;
  }, [items]);

  useEffect(() => {
    return () => {
      for (const url of urls.values()) URL.revokeObjectURL(url);
    };
  }, [urls]);

  if (items.length === 0) return null;

  return (
    <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4">
      {items.map((item) => {
        const url = urls.get(item.key) ?? null;
        return (
          <li key={item.key} className="relative overflow-hidden rounded-control border border-line bg-canvas/60">
            {url ? (
              onOpen ? (
                <button
                  type="button"
                  onClick={() => onOpen(item)}
                  aria-label={`${t("attachment.view")}: ${item.fileName}`}
                  className="block w-full"
                >
                  <img src={url} alt={item.fileName} className="aspect-square w-full object-cover" />
                </button>
              ) : (
                <img src={url} alt={item.fileName} className="aspect-square w-full object-cover" />
              )
            ) : (
              <div className="flex aspect-square w-full flex-col items-center justify-center gap-1 px-2 text-center">
                <Icon name="file" size={20} className="text-muted" />
                <span className="text-xs font-medium text-muted">{t("attachment.missing")}</span>
              </div>
            )}
            <span className="block truncate px-2 pb-1 pt-1.5 text-xs text-muted" title={item.fileName}>
              {item.fileName} · {formatSize(item.sizeBytes)}
            </span>
            <button
              type="button"
              onClick={() => onRemove(item)}
              aria-label={`${t("attachment.delete")}: ${item.fileName}`}
              className="absolute right-1 top-1 grid size-8 max-sm:size-11 place-items-center rounded-full bg-surface/90 text-muted shadow-sm transition-colors duration-200 hover:bg-danger/10 hover:text-danger"
            >
              <Icon name="trash" size={15} />
            </button>
          </li>
        );
      })}
    </ul>
  );
}
