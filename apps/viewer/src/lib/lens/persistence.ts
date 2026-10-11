/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { BUILTIN_LENSES, type Lens } from '@ifc-lite/lens';
import { encodeSavedLens, migrateSavedLens } from './migrate-saved-lens.js';
import { reconcileLibraryRows, LibraryRowsConflict } from '../storage/reconcile-library-rows.js';
import { readLocalLibrary, saveLocalLibrary, localLibraryWriteRefusal } from '../storage/local-library-source.js';
import type { SaveResult } from '../storage/save-result.js';

const STORAGE_KEY = 'ifc-lite-custom-lenses';
/** Ephemeral lens ID created when coloring from list column headers */
export const AUTO_COLOR_FROM_LIST_ID = 'auto-color-from-list';

/** Built-in lens IDs — used to detect overrides */
const BUILTIN_IDS = new Set(BUILTIN_LENSES.map(l => l.id));

/** Both startup and every save read the same complete native source (#7300). */
export function readSavedLensSource() {
  return readLocalLibrary<Lens>(STORAGE_KEY, value => {
    const lens = migrateSavedLens(value);
    return lens?.id ? { ...lens, id: lens.id } : null;
  });
}

/** What the save messages call the thing being persisted. */
const SAVE_SUBJECT = 'lens changes';

/**
 * Persist lenses to localStorage.
 * Saves custom lenses + any built-in lenses the user has edited (overrides).
 *
 * Returns a `SaveResult` rather than swallowing the failure: every CRUD action
 * below commits to the store only when the write actually landed, so the panel
 * can never show a lens that will be gone on reload.
 */
export function saveLenses(lenses: Lens[], baseline?: readonly Lens[]): Exclude<SaveResult, { ok: true }> | { ok: true; rows: Lens[] } {
  const source = readSavedLensSource();
  const refusal = localLibraryWriteRefusal(source, SAVE_SUBJECT);
  if (refusal) return refusal;
  let toStore: Lens[];
  let rows: Lens[];
  try {
    // Save non-builtin custom lenses, but never the ephemeral
    // "color from list column" lens — it is intentionally transient and must
    // not be restored as a stray "Color by …" lens on reload.
    rows = baseline ? reconcileLibraryRows(buildInitialLenses(source), baseline, lenses, row => {
      const normalized = migrateSavedLens(encodeSavedLens(row));
      if (!normalized) throw new Error('The Lens definition cannot be read.');
      return encodeSavedLens({ ...normalized, id: row.id });
    }) : lenses;
    const ephemeral = lenses.find(row => row.id === AUTO_COLOR_FROM_LIST_ID);
    if (ephemeral && !rows.some(row => row.id === ephemeral.id)) rows.push(ephemeral);
    const custom = rows.filter(l => !l.builtin && l.id !== AUTO_COLOR_FROM_LIST_ID);
    // Also save built-in lenses that differ from their defaults (user overrides)
    const builtinOverrides = rows.filter(l => {
      if (!l.builtin) return false;
      const original = BUILTIN_LENSES.find(b => b.id === l.id);
      if (!original) return false;
      // Has the user changed the name, rules, or auto-color spec? autoColor must
      // be part of this check or an autoColor-only edit to an auto-color builtin
      // (rules: []) imported via the JSON round-trip would be dropped on reload.
      return l.name !== original.name ||
        JSON.stringify(l.rules) !== JSON.stringify(original.rules) ||
        JSON.stringify(l.autoColor) !== JSON.stringify(original.autoColor) || JSON.stringify(l.capturedScope) !== JSON.stringify(original.capturedScope);
    });
    toStore = [...custom, ...builtinOverrides];
  } catch (error) {
    if (error instanceof LibraryRowsConflict) return { ok: false, reason: 'unavailable', message: error.message };
    console.warn('[Lenses] Failed to serialize lens overrides', error);
    // The override check stringifies rules/autoColor, so a non-serializable
    // lens fails here rather than in saveJson. Same class of failure.
    return { ok: false, reason: 'serialize', message: `Could not save ${SAVE_SUBJECT}.` };
  }
  const saved = saveLocalLibrary(STORAGE_KEY, toStore.map(encodeSavedLens), source, SAVE_SUBJECT);
  return saved.ok ? { ok: true, rows } : saved;
}

/** Build initial lens list: builtins (with overrides applied) + custom */
export function buildInitialLenses(source = readSavedLensSource()): Lens[] {
  const builtinOverrides = new Map<string, Lens[]>();
  const custom: Lens[] = [];
  for (const lens of source.rows) {
    if (BUILTIN_IDS.has(lens.id)) {
      const overrides = builtinOverrides.get(lens.id) ?? [];
      overrides.push({ ...lens, builtin: true });
      builtinOverrides.set(lens.id, overrides);
    } else custom.push(lens);
  }
  const builtins = BUILTIN_LENSES.flatMap(l =>
    builtinOverrides.get(l.id) ?? [{ ...l }],
  );
  return [...builtins, ...custom];
}

