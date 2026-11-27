/**
 * Reads a blob as a data URL. The label names the blob in the error, so a
 * failed read says what could not be read.
 */
export function blobAsDataUrl(blob: Blob, label: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error(`${label} could not be converted to a data URL`));
    };
    reader.onerror = () => reject(reader.error ?? new Error(`${label} could not be read`));
    reader.readAsDataURL(blob);
  });
}
