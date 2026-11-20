"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/i18n";
import type { Attachment } from "@/lib/domain/attachments";
import { errorCenter } from "@/lib/errors/ErrorCenter";
import { AppError } from "@/lib/errors/AppError";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { Icon } from "../ui/Icon";

const MIN_SCALE = 1;
const MAX_SCALE = 6;
const DOUBLE_TAP_MS = 300;

const clampScale = (scale: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));

interface View {
  scale: number;
  x: number;
  y: number;
}

interface Props {
  open: boolean;
  attachment: Attachment | null;
  /** Null when the file bytes are missing, for example after a restore without its asset. */
  blob: Blob | null;
  onClose: () => void;
  onDelete: (attachment: Attachment) => void;
}

interface PointerState {
  x: number;
  y: number;
  startX: number;
  startY: number;
}

/**
 * Full-screen image viewer. Pinch to zoom and drag to pan on touch, wheel
 * zoom and drag on desktop, double-tap to zoom. Escape and the close button
 * close it; delete sits behind a confirmation. Zoom and pan use Pointer
 * Events with touch-action none, so no extra gesture library is needed.
 */
export function AttachmentLightbox({ open, attachment, blob, onClose, onDelete }: Props) {
  const { t } = useI18n();
  const [view, setView] = useState<View>({ scale: 1, x: 0, y: 0 });
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const [viewportNode, setViewportNode] = useState<HTMLDivElement | null>(null);
  /** Callback ref: Radix mounts the dialog content one render after `open` turns true, so an effect keyed on `open` runs while the node is still null. The state update here re-runs the wheel effect once the node exists. */
  const setViewportRef = useCallback((node: HTMLDivElement | null) => {
    viewportRef.current = node;
    setViewportNode(node);
  }, []);
  const pointersRef = useRef(new Map<number, PointerState>());
  const pinchRef = useRef<{ startDistance: number; startScale: number; startX: number; startY: number; startMidX: number; startMidY: number } | null>(null);
  const lastTapRef = useRef<{ at: number; x: number; y: number } | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;

  useEffect(() => {
    setView({ scale: 1, x: 0, y: 0 });
    setConfirmDelete(false);
    pointersRef.current.clear();
    pinchRef.current = null;
  }, [attachment?.id, open]);

  useEffect(() => {
    if (!blob) {
      setUrl(null);
      return;
    }
    const objectUrl = URL.createObjectURL(blob);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [blob]);

  const zoomAt = useCallback((clientX: number, clientY: number, factor: number) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const rect = viewport.getBoundingClientRect();
    const px = clientX - rect.left - rect.width / 2;
    const py = clientY - rect.top - rect.height / 2;
    setView((v) => {
      const scale = clampScale(v.scale * factor);
      const k = scale / v.scale;
      return { scale, x: px - (px - v.x) * k, y: py - (py - v.y) * k };
    });
  }, []);

  const resetView = useCallback(() => setView({ scale: 1, x: 0, y: 0 }), []);

  // Wheel zoom must be non-passive to stop the page scrolling under the zoom.
  // The listener is attached once the viewport node exists (see setViewportRef).
  useEffect(() => {
    if (!viewportNode) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.002));
    };
    viewportNode.addEventListener("wheel", onWheel, { passive: false });
    return () => viewportNode.removeEventListener("wheel", onWheel);
  }, [viewportNode, zoomAt]);

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY });
    if (pointersRef.current.size === 2) {
      const [a, b] = [...pointersRef.current.values()];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      pinchRef.current = {
        startDistance: distance,
        startScale: viewRef.current.scale,
        startX: viewRef.current.x,
        startY: viewRef.current.y,
        startMidX: (a.x + b.x) / 2,
        startMidY: (a.y + b.y) / 2,
      };
    }
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const pointer = pointersRef.current.get(e.pointerId);
    if (!pointer) return;
    const prevX = pointer.x;
    const prevY = pointer.y;
    pointer.x = e.clientX;
    pointer.y = e.clientY;
    if (pointersRef.current.size === 2 && pinchRef.current) {
      const [a, b] = [...pointersRef.current.values()];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      const pinch = pinchRef.current;
      if (pinch.startDistance > 0) {
        const scale = clampScale(pinch.startScale * (distance / pinch.startDistance));
        const midX = (a.x + b.x) / 2;
        const midY = (a.y + b.y) / 2;
        setView({ scale, x: pinch.startX + (midX - pinch.startMidX), y: pinch.startY + (midY - pinch.startMidY) });
      }
      return;
    }
    // One finger drags the image. At the resting scale the image stays put;
    // past it, the drag pans the zoomed image.
    setView((v) => {
      if (v.scale <= MIN_SCALE) return v;
      const limit = 600 * v.scale;
      return { ...v, x: Math.max(-limit, Math.min(limit, v.x + (e.clientX - prevX))), y: Math.max(-limit, Math.min(limit, v.y + (e.clientY - prevY))) };
    });
  }

  function onPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    const pointer = pointersRef.current.get(e.pointerId);
    pointersRef.current.delete(e.pointerId);
    if (pointersRef.current.size < 2) pinchRef.current = null;
    if (!pointer || pointersRef.current.size !== 0) return;
    const moved = Math.hypot(e.clientX - pointer.startX, e.clientY - pointer.startY);
    if (moved > 10) {
      lastTapRef.current = null;
      return;
    }
    const now = Date.now();
    const last = lastTapRef.current;
    if (last && now - last.at < DOUBLE_TAP_MS) {
      lastTapRef.current = null;
      if (viewRef.current.scale > 1.5) resetView();
      else zoomAt(e.clientX, e.clientY, 2.5 / viewRef.current.scale);
    } else {
      lastTapRef.current = { at: now, x: e.clientX, y: e.clientY };
    }
  }

  function download() {
    if (!attachment || !blob) return;
    try {
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = attachment.fileName;
      a.click();
      // Revoke late: some browsers abort the download when the URL is
      // revoked before the download starts.
      setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
    } catch (e) {
      errorCenter.report(AppError.from(e), { action: "attachment.download" });
    }
  }

  return (
    <>
      <Dialog.Root
        open={open}
        onOpenChange={(isOpen) => {
          if (!isOpen) onClose();
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-[60] bg-plum-900/95">
            <Dialog.Content
              aria-describedby={undefined}
              className="flex h-full w-full flex-col outline-none"
            >
              <div className="flex min-h-14 items-center justify-between gap-2 px-3 py-2">
                <Dialog.Title className="min-w-0 flex-1 truncate text-base font-semibold text-white">
                  {attachment?.fileName ?? t("attachment.title")}
                </Dialog.Title>
                <Dialog.Close aria-label={t("action.close")} className="grid size-8 max-sm:size-11 shrink-0 place-items-center rounded-full text-white/80 transition-colors hover:bg-white/10 hover:text-white">
                  <Icon name="close" size={18} />
                </Dialog.Close>
              </div>

              <div
                ref={setViewportRef}
                role="region"
                aria-label={attachment?.fileName ?? t("attachment.title")}
                className="flex min-h-0 flex-1 touch-none items-center justify-center overflow-hidden"
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
              >
                {attachment && !blob && (
                  <div className="flex flex-col items-center gap-2 px-6 text-center">
                    <Icon name="file" size={28} className="text-white/60" />
                    <p className="text-sm font-medium text-white">{t("attachment.missing")}</p>
                    <p className="max-w-xs text-sm text-white/70">{t("attachment.missingHint")}</p>
                  </div>
                )}
                {attachment && blob && url && (
                  <img
                    src={url}
                    alt={attachment.fileName}
                    width={attachment.width}
                    height={attachment.height}
                    draggable={false}
                    className="max-h-full max-w-full select-none object-contain"
                    style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`, touchAction: "none" }}
                  />
                )}
              </div>

              <div className="flex flex-wrap items-center justify-center gap-2 px-3 pb-4 pt-2">
                <button type="button" onClick={() => zoomAt(window.innerWidth / 2, window.innerHeight / 2, 0.75)} className="inline-flex h-10 max-sm:min-h-11 items-center justify-center rounded-control border border-white/25 px-4 text-sm font-medium text-white transition-colors hover:bg-white/10">
                  {t("attachment.zoomOut")}
                </button>
                <button type="button" onClick={() => zoomAt(window.innerWidth / 2, window.innerHeight / 2, 1.33)} className="inline-flex h-10 max-sm:min-h-11 items-center justify-center rounded-control border border-white/25 px-4 text-sm font-medium text-white transition-colors hover:bg-white/10">
                  {t("attachment.zoomIn")}
                </button>
                <button type="button" onClick={resetView} className="inline-flex h-10 max-sm:min-h-11 items-center justify-center rounded-control border border-white/25 px-4 text-sm font-medium text-white transition-colors hover:bg-white/10">
                  {t("attachment.reset")}
                </button>
                <button type="button" disabled={!blob} onClick={download} className="inline-flex h-10 max-sm:min-h-11 items-center justify-center gap-2 rounded-control border border-white/25 px-4 text-sm font-medium text-white transition-colors hover:bg-white/10 disabled:opacity-50">
                  <Icon name="download" size={16} />
                  {t("attachment.download")}
                </button>
                <button type="button" disabled={!attachment} onClick={() => setConfirmDelete(true)} className="inline-flex h-10 max-sm:min-h-11 items-center justify-center gap-2 rounded-control bg-danger px-4 text-sm font-medium text-white transition-colors hover:brightness-95 disabled:opacity-50">
                  <Icon name="trash" size={16} />
                  {t("attachment.delete")}
                </button>
              </div>
            </Dialog.Content>
          </Dialog.Overlay>
        </Dialog.Portal>
      </Dialog.Root>

      <ConfirmDialog
        open={confirmDelete && attachment !== null}
        title={t("attachment.delete")}
        body={attachment ? t("attachment.deleteBody", { fileName: attachment.fileName }) : ""}
        confirmLabel={t("action.delete")}
        cancelLabel={t("action.cancel")}
        danger
        onConfirm={() => {
          if (!attachment) return;
          setConfirmDelete(false);
          onDelete(attachment);
        }}
        onCancel={() => setConfirmDelete(false)}
      />
    </>
  );
}
