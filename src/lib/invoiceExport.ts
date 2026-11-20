import { toPng } from "html-to-image";
import { jsPDF } from "jspdf";
import { AppError } from "@/lib/errors/AppError";

/** A4 page size in millimetres, the unit jsPDF works in. */
export const A4_WIDTH_MM = 210;
export const A4_HEIGHT_MM = 297;

/**
 * Pure layout math for fitting a rendered invoice image onto A4 pages: the
 * image is scaled to the full page width, and spills onto extra pages when
 * it is taller than one page.
 */
export function pdfPageLayout(imageWidth: number, imageHeight: number, pageWidth = A4_WIDTH_MM, pageHeight = A4_HEIGHT_MM): { scaledWidth: number; scaledHeight: number; pageCount: number } {
  const scaledWidth = pageWidth;
  const scaledHeight = (imageHeight * pageWidth) / imageWidth;
  const pageCount = Math.max(1, Math.ceil(scaledHeight / pageHeight));
  return { scaledWidth, scaledHeight, pageCount };
}

/** Downloads a data URL as a file through a temporary anchor click. */
function downloadDataUrl(dataUrl: string, fileName: string): void {
  const link = document.createElement("a");
  link.href = dataUrl;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

/** Renders the invoice document node to a PNG on a white background. */
async function renderPng(node: HTMLElement): Promise<string> {
  await waitForAttachments(node);
  await Promise.all(Array.from(node.querySelectorAll("img")).map((image) => image.decode()));
  return toPng(node, { backgroundColor: "#FFFFFF", pixelRatio: 2 });
}

/** Waits until attachment bytes have been converted to exportable image sources. */
function waitForAttachments(node: HTMLElement): Promise<void> {
  const status = () => node.dataset.attachmentsReady ?? "true";
  if (status() === "true") return Promise.resolve();
  if (status() === "error") return Promise.reject(new Error("invoice attachment could not be prepared"));

  return new Promise((resolve, reject) => {
    const observer = new MutationObserver(() => {
      const next = status();
      if (next === "true") {
        observer.disconnect();
        clearTimeout(timeout);
        resolve();
      } else if (next === "error") {
        observer.disconnect();
        clearTimeout(timeout);
        reject(new Error("invoice attachment could not be prepared"));
      }
    });
    const timeout = setTimeout(() => {
      observer.disconnect();
      reject(new Error("invoice attachments did not become ready"));
    }, 15_000);
    observer.observe(node, { attributes: true, attributeFilter: ["data-attachments-ready"] });
    if (status() === "true") {
      observer.disconnect();
      clearTimeout(timeout);
      resolve();
    } else if (status() === "error") {
      observer.disconnect();
      clearTimeout(timeout);
      reject(new Error("invoice attachment could not be prepared"));
    }
  });
}

/** Downloads the invoice as a PNG file named after its number. */
export async function downloadInvoicePng(node: HTMLElement, invoiceNumber: string): Promise<void> {
  try {
    const dataUrl = await renderPng(node);
    downloadDataUrl(dataUrl, `${invoiceNumber}.png`);
  } catch (e) {
    throw new AppError("EXPORT_FAILED", { cause: e });
  }
}

/** Downloads the invoice as an A4 PDF, spilling onto more pages when long. */
export async function downloadInvoicePdf(node: HTMLElement, invoiceNumber: string): Promise<void> {
  try {
    const dataUrl = await renderPng(node);
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("invoice image did not load"));
      image.src = dataUrl;
    });
    const { scaledWidth, scaledHeight, pageCount } = pdfPageLayout(image.naturalWidth, image.naturalHeight);
    const pdf = new jsPDF({ unit: "mm", format: "a4", orientation: "portrait" });
    for (let page = 0; page < pageCount; page++) {
      if (page > 0) pdf.addPage();
      pdf.addImage(dataUrl, "PNG", 0, -page * A4_HEIGHT_MM, scaledWidth, scaledHeight);
    }
    downloadDataUrl(pdf.output("datauristring"), `${invoiceNumber}.pdf`);
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError("EXPORT_FAILED", { cause: e });
  }
}
