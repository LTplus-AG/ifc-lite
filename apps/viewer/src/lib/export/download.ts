/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Canonical browser-export helpers: one filename sanitiser and one download
 * trigger, so every "Save as ..." path in the app behaves identically. Prefer
 * these over hand-rolling an `<a download>` blob dance or another bespoke
 * filename regex — see issue #1299 for what drifting copies cost us (uppercase
 * names lowercased, dotted classification codes hyphenated, dots underscored).
 */

export interface SanitizeFilenameOptions {
  /** Returned (and used as the base) when sanitising yields an empty string. Default `'file'`. */
  fallback?: string;
  /** Maximum length of the returned name. Default 60. */
  maxLength?: number;
}

/**
 * Make a user- or model-supplied name safe to use as a download filename
 * without mangling it. Case is preserved (so `DRAWINGS` stays `DRAWINGS`) and
 * dots are kept (so a classification code like `000.000` survives intact); only
 * characters that are genuinely unsafe in filenames (path separators, reserved
 * characters, control characters) are replaced with `-`. Whitespace runs
 * collapse to a single space and leading/trailing separators are trimmed.
 *
 * Pass only the stem — append the extension yourself (`${sanitizeFilename(x)}.csv`).
 *
 * Note: underscores are kept anywhere (including the ends — only space/dot/hyphen
 * are trimmed off the ends). `fallback` is returned verbatim when the result is
 * empty, so pass a clean token like `'list'` / `'model'`.
 */
export function sanitizeFilename(name: string, options: SanitizeFilenameOptions = {}): string {
  const fallback = options.fallback ?? 'file';
  const maxLength = options.maxLength ?? 60;
  const cleaned = (name || fallback)
    .replace(/\s+/g, ' ') // collapse all whitespace (tabs, newlines, runs) to one space
    // Keep letters (any case/script), digits, dot, underscore, space and hyphen;
    // replace anything else (path separators, reserved chars, controls) with '-'.
    .replace(/[^\p{L}\p{N}._ -]+/gu, '-')
    .replace(/^[\s.-]+|[\s.-]+$/g, '') // trim leading/trailing space, dot or hyphen
    .slice(0, maxLength)
    .replace(/[\s.-]+$/, ''); // re-trim in case slice() left a trailing separator
  return cleaned || fallback;
}

/** True when we can actually trigger a download (browser context). */
function canDownload(): boolean {
  return typeof document !== 'undefined' && typeof URL !== 'undefined';
}

function clickDownloadAnchor(href: string, filename: string): void {
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** Trigger a browser download of a `Blob`. No-op outside the browser. */
export function downloadBlob(blob: Blob, filename: string): void {
  if (!canDownload()) return;
  const url = URL.createObjectURL(blob);
  clickDownloadAnchor(url, filename);
  // Defer revocation: revoking synchronously can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

/**
 * Trigger a browser download of string or binary content, wrapping it in a
 * `Blob` first. Pass an explicit `mime` for text formats (e.g.
 * `'text/csv;charset=utf-8;'`); the default suits arbitrary binary payloads.
 *
 * Accepts the `Uint8Array<ArrayBufferLike>` that the Rust/wasm exporters return:
 * TS 5.7+ no longer treats that as a `BlobPart`, so we copy it into a fresh
 * `ArrayBuffer`-backed view here instead of making every caller do it.
 */
export function downloadFile(
  content: string | Uint8Array | ArrayBuffer | Blob,
  filename: string,
  mime = 'application/octet-stream',
): void {
  if (!canDownload()) return;
  if (content instanceof Blob) {
    downloadBlob(content, filename);
    return;
  }
  const part: BlobPart = content instanceof Uint8Array ? new Uint8Array(content) : content;
  downloadBlob(new Blob([part], { type: mime }), filename);
}

/**
 * Trigger a browser download from a `data:` (or other directly-addressable)
 * URL, e.g. a canvas `toDataURL()` screenshot. No-op outside the browser.
 */
export function downloadDataUrl(dataUrl: string, filename: string): void {
  if (!canDownload()) return;
  clickDownloadAnchor(dataUrl, filename);
}
