/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Lens JSON file import — reading, parsing and handing the result to the
 * store, pulled out of `LensPanel.handleImport` so the failure paths (a
 * File I/O error, malformed JSON, a store-level import refusal) can be
 * pinned without rendering the panel.
 */

/**
 * Read `file` as text, surfacing a failed read instead of leaving the
 * returned promise pending forever.
 *
 * `FileReader#onload` only fires on a SUCCESSFUL read; a failed one (file
 * removed/unreadable after picking, a permissions error, etc.) lands on
 * `onerror` instead. With only `onload` wired, a failed read produced
 * neither an import nor a toast — the promise this wraps would simply never
 * settle, so `.then`/`.catch` on it would never run either (PR #2091
 * review). Registering `onerror` before `readAsText` starts is what closes
 * that gap.
 */
export function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error('File read failed'));
    reader.readAsText(file);
  });
}

export type LensImportOutcome =
  | { ok: true }
  | { ok: false; message: string };

/**
 * Read, parse and import a lens JSON file. Every failure mode — the file
 * could not be read, its contents are not valid JSON, or the store refused
 * the import (e.g. it could not persist) — resolves to `{ ok: false,
 * message }` for the caller to toast, rather than resolving successfully or
 * (for the read failure specifically) never resolving at all.
 */
export async function importLensFile(
  file: File,
  importLenses: (lenses: readonly unknown[]) => { ok: boolean; message?: string },
): Promise<LensImportOutcome> {
  let text: string;
  try {
    text = await readFileAsText(file);
  } catch (err) {
    console.error('Lens file read failed:', err);
    return { ok: false, message: 'Could not read that file as lenses.' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    // Malformed JSON — well-formed-but-invalid lenses are filtered silently
    // by the importer, but a parse failure is worth telling the user about.
    console.error('Lens import failed:', err);
    return { ok: false, message: 'Could not read that file as lenses.' };
  }

  const result = importLenses(Array.isArray(parsed) ? parsed : [parsed]);
  return result.ok ? { ok: true } : { ok: false, message: result.message ?? 'Could not import lenses.' };
}
