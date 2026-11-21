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

export const BASELINE_KEY = 'ifc-lite-clash-revision-baseline';
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

function isStoredBaseline(v: unknown): v is { result: Record<string, unknown> & { clashes: unknown[] }; modelNames: unknown; takenAt: number } {
  if (!isPlainObject(v)) return false;
  if (!isPlainObject(v.result) || !Array.isArray(v.result.clashes)) return false;
  return isPlainObject(v.modelNames) && typeof v.takenAt === 'number';
}

/** The native baseline format also serves as the portable backup codec. */
export function decodeRevisionBaseline(text: string): ClashRevisionBaseline {
  const parsed: unknown = JSON.parse(text);
  if (!isPlainObject(parsed) || parsed.schemaVersion !== SCHEMA_VERSION || !isStoredBaseline(parsed.baseline)) {
    throw new Error('Invalid or unsupported saved clash baseline');
  }
  const { result, modelNames, takenAt } = parsed.baseline;
  const isRef = (ref: unknown) => isPlainObject(ref) && typeof ref.model === 'string' && typeof ref.key === 'string';
  if (!Number.isFinite(takenAt) || !isPlainObject(modelNames) || Object.values(modelNames).some(name => typeof name !== 'string')
    || !Array.isArray(result.rulesRun) || !result.rulesRun.every(rule => isPlainObject(rule) && typeof rule.id === 'string')
    || !result.clashes.every(clash => isPlainObject(clash) && typeof clash.id === 'string' && typeof clash.rule === 'string'
      && typeof clash.status === 'string' && typeof clash.severity === 'string'
      && (typeof clash.distance === 'number' || clash.distance === null) && isRef(clash.a) && isRef(clash.b))
    || (result.ruleCoverage !== undefined && (!Array.isArray(result.ruleCoverage) || !result.ruleCoverage.every(isPlainObject)))) {
    throw new Error('Invalid saved clash baseline result');
  }
  return { result: result as unknown as ClashResult, modelNames: modelNames as Record<string, string>, takenAt };
}

/** Read the saved baseline, or `null` when none is stored / it fails to parse
 *  / its shape or schema version cannot be trusted. Every rejection is logged
 *  with a reason, never a silent swallow, so a corrupted or stale-schema
 *  value is diagnosable from the console rather than looking like "nothing
 *  was ever saved". */
export function loadRevisionBaseline(): ClashRevisionBaseline | null {
  const storage = optionalLocalStorage();
  if (!storage) return null;
  try {
    const raw = storage.getItem(BASELINE_KEY);
    if (raw === null) return null;
    return decodeRevisionBaseline(raw);
  } catch (err) {
    console.warn('[clash] failed to read saved revision baseline; treating as absent.', err);
    return null;
  }
}

/**
 * Drop the per-element key arrays #3947 added to `ClashRuleCoverage`
 * (`matchedKeysA`/`matchedKeysB`) before a result is persisted as a baseline.
 *
 * They are unconditional and unbounded by rule breadth — a broad rule on a
 * large federated model can duplicate every matched element's durable key
 * into the stored baseline (#3953) — but `compareClashRevisions` (in
 * `@ifc-lite/clash`'s `revision.ts`) never reads a BASELINE's own
 * `matchedKeysA`/`matchedKeysB`: `ruleMatchedKeys` and `noMatchRuleIdSet` are
 * only ever called on the CURRENT run passed to `compareClashRevisions`, and
 * the viewer's only other consumer of a loaded baseline
 * (`ClashRevisionCompareDialog`) reads just `result.clashes.length`. Stripping
 * them here removes dead weight, not information the comparison needs —
 * every other `ClashRuleCoverage` field (the match counts, `fromMembersA/B`)
 * is small and kept.
 */
function stripUnusedCoverage(result: ClashResult): ClashResult {
  if (!result.ruleCoverage) return result;
  return {
    ...result,
    ruleCoverage: result.ruleCoverage.map(({ matchedKeysA: _a, matchedKeysB: _b, matchedElements: _objects, ...rest }) => rest),
  };
}

const baselineListeners = new Set<() => void>();
export function notifyBaselineChange(): void {
  for (const listener of baselineListeners) {
    try { listener(); } catch (error) { console.warn('[clash] baseline change listener failed', error); }
  }
}
/** Native saves, clears and writes from another tab invalidate baseline-derived evidence. */
export function subscribeRevisionBaseline(listener: () => void): () => void {
  baselineListeners.add(listener);
  const onStorage = (event: StorageEvent) => { if (event.key === BASELINE_KEY || event.key === null) listener(); };
  if (typeof window !== 'undefined') window.addEventListener('storage', onStorage);
  return () => { baselineListeners.delete(listener); if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage); };
}

export function encodeRevisionBaseline(baseline: ClashRevisionBaseline): string {
  return JSON.stringify({ schemaVersion: SCHEMA_VERSION, baseline: { ...baseline, result: stripUnusedCoverage(baseline.result) } });
}

/** Save (or clear, with `null`) the baseline. */
export function saveRevisionBaseline(baseline: ClashRevisionBaseline | null): SaveResult {
  const storage = optionalLocalStorage();
  if (!storage) return { ok: false, reason: 'unreadable', message: 'Local storage is unavailable.' };
  try {
    if (baseline === null) {
      storage.removeItem(BASELINE_KEY);
      notifyBaselineChange();
      return { ok: true };
    }
    const payload = encodeRevisionBaseline(baseline);
    storage.setItem(BASELINE_KEY, payload);
    notifyBaselineChange();
    return { ok: true };
  } catch (error) {
    console.warn('[clash] failed to save revision baseline', error);
    return { ok: false, reason: 'quota', message: 'Browser storage is full; the baseline was not saved.' };
  }
}
