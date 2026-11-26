import { toPng } from "html-to-image";
import { jsPDF } from "jspdf";
import { AppError } from "@/lib/errors/AppError";

/** A4 page size in millimetres, the unit jsPDF works in. */
export const A4_WIDTH_MM = 210;
export const A4_HEIGHT_MM = 297;

/**
 * Pure layout math for fitting a rendered document image onto A4 pages: the
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

/** Renders a document node to a PNG on a white background. */
async function renderPng(node: HTMLElement, label: string): Promise<string> {
  await waitForAttachments(node, label);
  await Promise.all(Array.from(node.querySelectorAll("img")).map((image) => image.decode()));
  return toPng(node, { backgroundColor: "#FFFFFF", pixelRatio: 2 });
}

/**
 * Waits until the document's image bytes have been converted to exportable
 * sources. The document reports its readiness through data-attachments-ready:
 * "true" when ready, "error" when a conversion failed. Label is the document
 * kind, used in the error so the failure names what was being exported.
 */
function waitForAttachments(node: HTMLElement, label: string): Promise<void> {
  const status = () => node.dataset.attachmentsReady ?? "true";
  if (status() === "true") return Promise.resolve();
  if (status() === "error") return Promise.reject(new Error(`${label} attachment could not be prepared`));

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
        reject(new Error(`${label} attachment could not be prepared`));
      }
    });
    const timeout = setTimeout(() => {
      observer.disconnect();
      reject(new Error(`${label} attachments did not become ready`));
    }, 15_000);
    observer.observe(node, { attributes: true, attributeFilter: ["data-attachments-ready"] });
    if (status() === "true") {
      observer.disconnect();
      clearTimeout(timeout);
      resolve();
    } else if (status() === "error") {
      observer.disconnect();
      clearTimeout(timeout);
      reject(new Error(`${label} attachment could not be prepared`));
    }
  });
}

/** Downloads a rendered document as a PNG file. */
async function downloadDocumentPng(node: HTMLElement, fileName: string, label: string): Promise<void> {
  try {
    const dataUrl = await renderPng(node, label);
    downloadDataUrl(dataUrl, `${fileName}.png`);
  } catch (e) {
    throw new AppError("EXPORT_FAILED", { cause: e });
  }
}

/** Downloads a rendered document as an A4 PDF, spilling onto more pages when long. */
async function downloadDocumentPdf(node: HTMLElement, fileName: string, label: string): Promise<void> {
  try {
    const dataUrl = await renderPng(node, label);
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error(`${label} image did not load`));
      image.src = dataUrl;
    });
    const { scaledWidth, scaledHeight, pageCount } = pdfPageLayout(image.naturalWidth, image.naturalHeight);
    const pdf = new jsPDF({ unit: "mm", format: "a4", orientation: "portrait" });
    for (let page = 0; page < pageCount; page++) {
      if (page > 0) pdf.addPage();
      pdf.addImage(dataUrl, "PNG", 0, -page * A4_HEIGHT_MM, scaledWidth, scaledHeight);
    }
    downloadDataUrl(pdf.output("datauristring"), `${fileName}.pdf`);
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError("EXPORT_FAILED", { cause: e });
  }
}

/** Downloads the invoice as a PNG file named after its number. */
export async function downloadInvoicePng(node: HTMLElement, invoiceNumber: string): Promise<void> {
  return downloadDocumentPng(node, invoiceNumber, "invoice");
}

/** Downloads the invoice as an A4 PDF, spilling onto more pages when long. */
export async function downloadInvoicePdf(node: HTMLElement, invoiceNumber: string): Promise<void> {
  return downloadDocumentPdf(node, invoiceNumber, "invoice");
}

/** Downloads the paycheck as a PNG file named after the given file base. */
export async function downloadPaycheckPng(node: HTMLElement, fileName: string): Promise<void> {
  return downloadDocumentPng(node, fileName, "paycheck");
}

/** Downloads the paycheck as an A4 PDF, spilling onto more pages when long. */
export async function downloadPaycheckPdf(node: HTMLElement, fileName: string): Promise<void> {
  return downloadDocumentPdf(node, fileName, "paycheck");
}
