/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Canonical browser-export helpers: one filename sanitiser, one
 * extension-aware filename builder, and one download trigger, so every
 * "Save as ..." path in the app behaves identically. Prefer these over
 * hand-rolling an `<a download>` blob dance or another bespoke filename
 * regex — see issue #1299 for what drifting copies cost us (uppercase names
 * lowercased, dotted classification codes hyphenated, dots underscored).
 *
 * `buildExportFilename`/`normalizeExtension` used to live in a separate
 * `extension-filename.ts` sibling; they moved here because this module is
 * already the declared canonical home for filename handling, and "extension"
 * in that old filename punned file-extension against viewer-extension.
 */

import { emitFileDownloaded } from '@/lib/tours/events';

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

/** No real file extension is longer than this; caps a pathological input. */
const EXTENSION_MAX_LENGTH = 16;

/** Normalise a declared extension to a leading-dot form (`csv` -> `.csv`). */
export function normalizeExtension(extension: string): string {
  return extension.startsWith('.') ? extension : `.${extension}`;
}

/**
 * Build the download filename `stem.ext`, sanitizing the stem and extension
 * SEPARATELY and budgeting the stem so the whole result fits inside
 * `maxLength`.
 *
 * `sanitizeFilename` slices to `maxLength` internally, so sanitizing the
 * already-concatenated `${baseName}${ext}` truncates from the right and can
 * cut the extension off entirely for a long base name — turning e.g.
 * `some-very-long-model-name-that-keeps-going-and-going.csv` into a file
 * with no extension at all, which browsers then treat as
 * `application/octet-stream` regardless of the declared mime type.
 *
 * The extension itself is capped at `EXTENSION_MAX_LENGTH` before the stem
 * budget is computed — without that cap, a pathological (or malicious)
 * extension string could consume the whole `maxLength` budget and push the
 * final `stem.ext` past `maxLength`, breaking the very contract this
 * function exists to uphold.
 */
export function buildExportFilename(
  baseName: string,
  extension: string,
  maxLength = 60,
): string {
  const ext = normalizeExtension(extension);
  // Reserve at least 1 char for the stem: cap the extension's own budget
  // below maxLength so stemBudget below is never zero-or-negative.
  const extBudget = Math.min(EXTENSION_MAX_LENGTH, Math.max(1, maxLength - 1));
  const sanitizedExt = `.${sanitizeFilename(ext.slice(1), { fallback: 'dat', maxLength: extBudget })}`;
  const stemBudget = Math.max(1, maxLength - sanitizedExt.length);
  const stem = sanitizeFilename(baseName, { maxLength: stemBudget });
  return `${stem}${sanitizedExt}`;
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
  // Every save-as path funnels through here, which makes it the one seam
  // task-gated tours (and anything else) can observe exports from.
  emitFileDownloaded(filename);
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
