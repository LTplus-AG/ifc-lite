/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * localStorage persistence of model tag DEFINITIONS (issue #4215).
 *
 * Only the definitions live here. Assignments are federation metadata — which
 * model carries which tag — and a browser-wide store cannot say which
 * federation they belong to; they travel with the portable setup file instead
 * (`lib/federation/federationSetupFile.ts`). Keeping the definitions lets a
 * coordinator re-tag a re-added model from the same vocabulary, and keeps the
 * ids a saved advanced filter references alive across a reload.
 */

import { isModelTagOp, normalizeModelTagName, type ModelTag } from './types.js';

export const MODEL_TAGS_STORAGE_KEY = 'ifc-lite:model-tags';

/** Read one tag off untrusted JSON; `null` when it is not one. */
export function parseModelTag(raw: unknown): ModelTag | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as { id?: unknown; name?: unknown; color?: unknown };
  if (typeof r.id !== 'string' || r.id.length === 0) return null;
  if (typeof r.name !== 'string' || normalizeModelTagName(r.name).length === 0) return null;
  if (r.color !== undefined && typeof r.color !== 'string') return null;
  return { id: r.id, name: r.name.trim(), ...(r.color ? { color: r.color } : {}) };
}

/**
 * Read a tag list off untrusted JSON, dropping entries that are not tags and
 * any later entry that repeats an earlier id or (case-insensitively) an
 * earlier name — the slice's own uniqueness rules, applied at the boundary so
 * the store never holds two tags the editor cannot tell apart.
 */
export function parseModelTags(raw: unknown): ModelTag[] {
  if (!Array.isArray(raw)) return [];
  const out: ModelTag[] = [];
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const entry of raw) {
    const tag = parseModelTag(entry);
    if (!tag) continue;
    const key = normalizeModelTagName(tag.name);
    if (ids.has(tag.id) || names.has(key)) continue;
    ids.add(tag.id);
    names.add(key);
    out.push(tag);
  }
  return out;
}

/** Is `raw` a persisted `{ op, tagIds }` model-tag reference (list scope, setup file)? */
export function isModelTagRef(raw: unknown): raw is { op: string; tagIds: string[] } {
  if (!raw || typeof raw !== 'object') return false;
  const r = raw as { op?: unknown; tagIds?: unknown };
  return isModelTagOp(r.op) && Array.isArray(r.tagIds) && r.tagIds.every((t) => typeof t === 'string');
}

export function loadPersistedModelTags(): ModelTag[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(MODEL_TAGS_STORAGE_KEY);
    return raw ? parseModelTags(JSON.parse(raw)) : [];
  } catch (error) {
    console.warn('[model-tags] failed to load persisted tag definitions', error);
    return [];
  }
}

export function savePersistedModelTags(tags: readonly ModelTag[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(MODEL_TAGS_STORAGE_KEY, JSON.stringify(tags));
  } catch (error) {
    // Quota / private mode — best effort; the setup file is the durable path.
    console.warn('[model-tags] failed to persist tag definitions', error);
  }
}
