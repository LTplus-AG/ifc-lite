/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Persistence for the ONE clash-run "baseline" a coordinator can compare the
 * current result against (issue #3928 — `@ifc-lite/clash`'s `compareClashRevisions`
 * had no viewer consumer). Mirrors `./persistence.ts`'s localStorage pattern
 * (one JSON blob, `SaveResult` on write) but deliberately kept separate and
 * small: reviews/presets/settings are coordination decisions that must never
 * be silently lost, while a baseline is a disposable snapshot the user can
 * always re-save with one click, so it does not need that file's
 * preserve-on-unreadable machinery.
 */

import type { ClashResult } from '@ifc-lite/clash';
import { optionalLocalStorage } from '../storage/unreadable-entry.js';
import type { SaveResult } from './persistence.js';

const BASELINE_KEY = 'ifc-lite-clash-revision-baseline';
const SCHEMA_VERSION = 1;

/**
 * A saved baseline run plus the durable identity of every model it drew
 * clashes from — see `@ifc-lite/clash`'s `ClashRevisionSide` for why the raw
 * `ClashElementRef.model` id (an ephemeral per-load id) cannot be compared
 * across a reload on its own.
 */
export interface ClashRevisionBaseline {
  result: ClashResult;
  /** Ephemeral `ClashElementRef.model` id (as captured at save time) → durable
   *  display name (the model's filename in the viewer). */
  modelNames: Record<string, string>;
  /** Epoch-ms this baseline was captured, for the "saved 3 minutes ago" label. */
  takenAt: number;
}

/** Build the `modelId → name` map `ClashRevisionSide` needs, restricted to the
 *  models a result's own clashes actually reference (so a stale/renamed model
 *  elsewhere in the federation cannot leak in as a false "still there"). */
export function captureModelNames(
  result: ClashResult,
  models: ReadonlyMap<string, { name: string }>,
): Record<string, string> {
  const names: Record<string, string> = {};
  for (const clash of result.clashes) {
    for (const ref of [clash.a, clash.b]) {
      if (names[ref.model] !== undefined) continue;
      const name = models.get(ref.model)?.name;
      if (name !== undefined) names[ref.model] = name;
    }
  }
  return names;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Minimal structural check — this is a same-origin, same-app round trip
 *  (never cross-version import), so it only needs to reject garbage, not
 *  validate every field of a foreign `ClashResult`. */
function isStoredBaseline(v: unknown): v is { result: unknown; modelNames: unknown; takenAt: number } {
  if (!isPlainObject(v)) return false;
  return isPlainObject(v.result) && isPlainObject(v.modelNames) && typeof v.takenAt === 'number';
}

/** Read the saved baseline, or `null` when none is stored / it fails to parse. */
export function loadRevisionBaseline(): ClashRevisionBaseline | null {
  const storage = optionalLocalStorage();
  if (!storage) return null;
  try {
    const raw = storage.getItem(BASELINE_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    const body = isPlainObject(parsed) ? parsed.baseline : null;
    if (!isStoredBaseline(body)) return null;
    const modelNames: Record<string, string> = {};
    for (const [id, name] of Object.entries(body.modelNames as Record<string, unknown>)) {
      if (typeof name === 'string') modelNames[id] = name;
    }
    return { result: body.result as ClashResult, modelNames, takenAt: body.takenAt };
  } catch (err) {
    console.warn('[clash] failed to read saved revision baseline; treating as absent.', err);
    return null;
  }
}

/** Save (or clear, with `null`) the baseline. */
export function saveRevisionBaseline(baseline: ClashRevisionBaseline | null): SaveResult {
  const storage = optionalLocalStorage();
  if (!storage) return { ok: false, reason: 'unreadable', message: 'Local storage is unavailable.' };
  try {
    if (baseline === null) {
      storage.removeItem(BASELINE_KEY);
      return { ok: true };
    }
    const payload = JSON.stringify({ schemaVersion: SCHEMA_VERSION, baseline });
    storage.setItem(BASELINE_KEY, payload);
    return { ok: true };
  } catch {
    return { ok: false, reason: 'quota', message: 'Browser storage is full; the baseline was not saved.' };
  }
}
