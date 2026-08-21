/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Persistence for user scripts via localStorage.
 *
 * Uses a versioned schema so future additions (tags, description, etc.)
 * can be migrated without data loss.
 */

/** Current schema version */
const SCHEMA_VERSION = 1;

export interface SavedScript {
  id: string;
  name: string;
  code: string;
  createdAt: number;
  updatedAt: number;
  version: number;
}

/** Stored wrapper with schema version for migration */
interface StoredScripts {
  schemaVersion: number;
  scripts: SavedScript[];
}

const STORAGE_KEY = 'ifc-lite-scripts';

/** Maximum scripts allowed (prevents storage exhaustion) */
const MAX_SCRIPTS = 500;

/** Maximum code size per script in characters (~100KB) */
const MAX_SCRIPT_SIZE = 100_000;

export function loadSavedScripts(): SavedScript[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];

    const parsed: unknown = JSON.parse(raw);

    // Handle legacy format (bare array without schema version)
    if (Array.isArray(parsed)) {
      return migrateFromLegacy(parsed);
    }

    // Versioned format — validate structure
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'schemaVersion' in parsed &&
      'scripts' in parsed &&
      Array.isArray((parsed as StoredScripts).scripts)
    ) {
      // The array shape being right says nothing about each element: a
      // hand-edited or partially-written entry (e.g. `{}`) is valid JSON of
      // the right container type but the wrong element shape. Returning it
      // unchecked hands callers a "SavedScript" missing `code`/timestamps —
      // `script.code.length` in scriptSlice.ts's setActiveScriptId then
      // throws the moment that entry is opened. The legacy (bare-array)
      // branch above already validates every field via migrateFromLegacy;
      // this branch must not be the weaker path for the exact same data.
      return (parsed as StoredScripts).scripts.filter(isValidStoredScript);
    }

    return [];
  } catch {
    return [];
  }
}

function isValidStoredScript(value: unknown): value is SavedScript {
  if (!value || typeof value !== 'object') return false;
  const s = value as Record<string, unknown>;
  return (
    typeof s.id === 'string' && s.id.length > 0 &&
    typeof s.name === 'string' &&
    typeof s.code === 'string' &&
    typeof s.createdAt === 'number' && Number.isFinite(s.createdAt) &&
    typeof s.updatedAt === 'number' && Number.isFinite(s.updatedAt) &&
    typeof s.version === 'number'
  );
}

/** Migrate from the original unversioned format — discards corrupted entries */
function migrateFromLegacy(scripts: unknown[]): SavedScript[] {
  const migrated: SavedScript[] = [];
  for (const s of scripts) {
    if (s === null || typeof s !== 'object') continue;
    const script = s as Record<string, unknown>;

    // Validate essential fields — discard garbage values from String()/Number() coercion
    const id = typeof script.id === 'string' && script.id.length > 0 ? script.id : crypto.randomUUID();
    const name = typeof script.name === 'string' && script.name.length > 0 ? script.name : 'Untitled';
    const code = typeof script.code === 'string' ? script.code : '';
    const createdAt = typeof script.createdAt === 'number' && isFinite(script.createdAt) ? script.createdAt : Date.now();
    const updatedAt = typeof script.updatedAt === 'number' && isFinite(script.updatedAt) ? script.updatedAt : Date.now();

    migrated.push({ id, name, code, createdAt, updatedAt, version: SCHEMA_VERSION });
  }
  // Save in new format
  saveScripts(migrated);
  return migrated;
}

export type SaveResult =
  | { ok: true }
  | { ok: false; reason: 'quota_exceeded' | 'serialization_error' | 'unknown'; message: string };

export function saveScripts(scripts: SavedScript[]): SaveResult {
  const stored: StoredScripts = {
    schemaVersion: SCHEMA_VERSION,
    scripts,
  };

  try {
    const json = JSON.stringify(stored);
    localStorage.setItem(STORAGE_KEY, json);
    return { ok: true };
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === 'QuotaExceededError') {
      console.warn('[Scripts] localStorage quota exceeded. Consider deleting unused scripts.');
      return { ok: false, reason: 'quota_exceeded', message: 'Storage quota exceeded. Delete unused scripts to free space.' };
    }
    if (err instanceof TypeError) {
      console.warn('[Scripts] Failed to serialize scripts:', err.message);
      return { ok: false, reason: 'serialization_error', message: err.message };
    }
    console.warn('[Scripts] Failed to save scripts to localStorage');
    return { ok: false, reason: 'unknown', message: String(err) };
  }
}

/** Validate a script name — returns sanitized name or null if invalid */
export function validateScriptName(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > 100) return trimmed.slice(0, 100);
  return trimmed;
}

/** Check if adding another script is within limits */
export function canCreateScript(currentCount: number): boolean {
  return currentCount < MAX_SCRIPTS;
}

/** Check if script code is within size limits */
export function isScriptWithinSizeLimit(code: string): boolean {
  return code.length <= MAX_SCRIPT_SIZE;
}
