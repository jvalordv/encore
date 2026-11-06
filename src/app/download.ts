/**
 * Hands a blob to the browser as a file download. The one DOM touch of saving
 * a take; kept apart from the pure export code in take-export.ts. The object
 * URL is revoked after the click has been handled.
 */

/** Milliseconds the object URL stays valid after the click. */
const REVOKE_AFTER_MS = 4000;

/** Starts a download of `blob` named `name` from the document's page. */
export function downloadBlob(doc: Document, blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const link = doc.createElement('a');
  link.href = url;
  link.download = name;
  link.hidden = true;
  doc.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_AFTER_MS);
}
