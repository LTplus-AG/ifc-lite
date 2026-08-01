/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Build a download filename from a base name plus a declared file
 * extension, keeping the extension intact even when the base name is long.
 *
 * Lives next to `download.ts` (whose `sanitizeFilename` this depends on) as
 * a plain module — no React/UI imports — so it can be unit-tested with
 * `tsx --test` the same way as every other pure helper in this package
 * (`apps/viewer` has no `.test.tsx` / DOM rendering harness).
 */

import { sanitizeFilename } from './download.js';

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
