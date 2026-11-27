import { AppError } from "@/lib/errors/AppError";
import type { MessageKey } from "@/i18n/types";
import { MAX_ATTACHMENT_BYTES } from "@/lib/domain/attachments";

const ACCEPTED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;

const MAX_EDGE_PX = 1920;
const JPEG_QUALITY = 0.82;

export interface PreparedAttachment {
  blob: Blob;
  fileName: string;
  mimeType: string;
  width: number;
  height: number;
  sizeBytes: number;
}

export class AttachmentRejection extends Error {
  readonly key: MessageKey;
  readonly vars: Record<string, string | number>;
  constructor(key: MessageKey, vars: Record<string, string | number> = {}) {
    super(key);
    this.name = "AttachmentRejection";
    this.key = key;
    this.vars = vars;
  }
}

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

const MIME_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
};

/** MIME type for a file extension, used when the picked file carries no type. */
function mimeForExtension(fileName: string): string {
  return MIME_BY_EXT[extensionOf(fileName)] ?? "image/jpeg";
}

/** File extension for a stored image type, used for the backup asset name. */
export function extensionForMime(mimeType: string): string {
  return EXT_BY_MIME[mimeType] ?? "bin";
}

/** Dimensions after shrinking the longest edge to the limit, keeping the ratio. */
export function scaledDimensions(width: number, height: number, maxEdge: number = MAX_EDGE_PX): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= maxEdge) return { width, height };
  const scale = maxEdge / longest;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** File name with its extension replaced by .jpg, for an image re-encoded as JPEG. */
function fileNameWithJpegExtension(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  const base = dot > 0 ? fileName.slice(0, dot) : fileName;
  return `${base || "image"}.jpg`;
}

function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot >= 0 ? fileName.slice(dot + 1).toLowerCase() : "";
}

/** True when the file is one of the accepted image types, by MIME type or, when the type is empty, by extension. */
function isAcceptedImage(file: Blob, fileName: string): boolean {
  if ((ACCEPTED_IMAGE_TYPES as readonly string[]).includes(file.type)) return true;
  if (file.type === "") return ["jpg", "jpeg", "png", "webp", "gif"].includes(extensionOf(fileName));
  return false;
}

function loadBitmap(file: Blob): Promise<{ width: number; height: number; draw: (ctx: CanvasRenderingContext2D, width: number, height: number) => void; close: () => void }> {
  if (typeof createImageBitmap === "function") {
    return createImageBitmap(file).then((bitmap) => ({
      width: bitmap.width,
      height: bitmap.height,
      draw: (ctx, width, height) => ctx.drawImage(bitmap, 0, 0, width, height),
      close: () => bitmap.close(),
    }));
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve({
        width: img.naturalWidth,
        height: img.naturalHeight,
        draw: (ctx, width, height) => ctx.drawImage(img, 0, 0, width, height),
        close: () => {},
      });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new AttachmentRejection("attachment.unreadable", { fileName: "" }));
    };
    img.src = url;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new AppError("UNEXPECTED", { details: "canvas could not encode the image" }));
      },
      type,
      quality,
    );
  });
}

/**
 * Checks one picked file and shrinks it when needed. Images that already fit
 * the size and dimension limits are kept byte for byte, so transparency and
 * animation survive; oversized ones are downscaled and re-encoded as JPEG.
 * Rejects anything that is not an image, anything unreadable, and anything
 * still over the limit after shrinking.
 */
export async function prepareImageFile(file: Blob, fileName: string): Promise<PreparedAttachment> {
  if (!isAcceptedImage(file, fileName)) {
    throw new AttachmentRejection("attachment.notImage", { fileName });
  }
  let bitmap: Awaited<ReturnType<typeof loadBitmap>>;
  try {
    bitmap = await loadBitmap(file);
  } catch (e) {
    if (e instanceof AttachmentRejection) throw new AttachmentRejection(e.key, { fileName });
    throw new AppError("UNEXPECTED", { details: `could not read ${fileName} as an image`, cause: e });
  }
  try {
    const { width, height } = bitmap;
    if (!width || !height) throw new AttachmentRejection("attachment.unreadable", { fileName });
    if (width <= MAX_EDGE_PX && height <= MAX_EDGE_PX && file.size <= MAX_ATTACHMENT_BYTES) {
      return { blob: file, fileName, mimeType: file.type || mimeForExtension(fileName), width, height, sizeBytes: file.size };
    }
    const target = scaledDimensions(width, height);
    const canvas = document.createElement("canvas");
    canvas.width = target.width;
    canvas.height = target.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new AppError("UNEXPECTED", { details: "canvas 2d context is unavailable" });
    bitmap.draw(ctx, target.width, target.height);
    const shrunk = await canvasToBlob(canvas, "image/jpeg", JPEG_QUALITY);
    if (shrunk.size > MAX_ATTACHMENT_BYTES) {
      throw new AttachmentRejection("attachment.tooLarge", { fileName });
    }
    return { blob: shrunk, fileName: fileNameWithJpegExtension(fileName), mimeType: "image/jpeg", width: target.width, height: target.height, sizeBytes: shrunk.size };
  } finally {
    bitmap.close();
  }
}
