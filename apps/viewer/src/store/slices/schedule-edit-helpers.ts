/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pure helpers for the schedule edit pipeline: ISO-8601 date / duration
 * math, deep-clone of the extraction, and federation-id helpers. Extracted
 * from scheduleSlice.ts so the slice file focuses on state + mutators and
 * these functions can be unit-tested in isolation.
 *
 * No Zustand imports here — every function is pure (or state-less enough
 * to accept raw inputs).
 */

import type { ScheduleExtraction } from '@ifc-lite/parser';

// ═════════════════════════════════════════════════════════════════════
// ISO-8601 date/time helpers
// ═════════════════════════════════════════════════════════════════════

/**
 * Convert an ISO 8601 datetime string to epoch ms. Returns undefined when
 * the input is missing or unparseable.
 *
 * `IfcDateTime` values produced by authoring tools are typically written
 * without a timezone designator (e.g. `2024-05-01T08:00:00`). `Date.parse`
 * treats those as *local* time, so the same IFC opened on machines in
 * different timezones would yield different epoch values — shifting the
 * Gantt and breaking equality with exported STEP strings. We normalize
 * TZ-less inputs to UTC (append `Z`) so playback stays stable across
 * machines and STEP round-trips.
 */
export function parseIsoDate(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const hasTz = /Z$|[+-]\d{2}:?\d{2}$/.test(value);
  const normalized = hasTz ? value : `${value}Z`;
  const t = Date.parse(normalized);
  return Number.isNaN(t) ? undefined : t;
}

/** Emit an ISO 8601 P…T… duration from a millisecond quantity. */
export function msToIsoDuration(ms: number): string {
  const clamped = Math.max(0, Math.round(ms));
  if (clamped === 0) return 'PT0S';
  const days = Math.floor(clamped / 86_400_000);
  const remAfterDays = clamped - days * 86_400_000;
  const hours = Math.floor(remAfterDays / 3_600_000);
  const remAfterHours = remAfterDays - hours * 3_600_000;
  const mins = Math.floor(remAfterHours / 60_000);
  const secs = Math.floor((remAfterHours - mins * 60_000) / 1000);
  let out = 'P';
  if (days > 0) out += `${days}D`;
  if (hours > 0 || mins > 0 || secs > 0) {
    out += 'T';
    if (hours > 0) out += `${hours}H`;
    if (mins > 0) out += `${mins}M`;
    if (secs > 0) out += `${secs}S`;
  }
  return out === 'P' ? 'P0D' : out;
}

export function addIsoDurationToEpoch(start: number, iso: string): number | undefined {
  const match = iso.match(
    /^P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)W)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/,
  );
  if (!match) return undefined;
  const [, y, mo, w, d, h, mi, s] = match;
  const yearMs = 365.2425 * 86_400_000;
  const monthMs = yearMs / 12;
  const total =
    (y ? parseFloat(y) * yearMs : 0) +
    (mo ? parseFloat(mo) * monthMs : 0) +
    (w ? parseFloat(w) * 7 * 86_400_000 : 0) +
    (d ? parseFloat(d) * 86_400_000 : 0) +
    (h ? parseFloat(h) * 3_600_000 : 0) +
    (mi ? parseFloat(mi) * 60_000 : 0) +
    (s ? parseFloat(s) * 1000 : 0);
  return start + total;
}

/** Epoch ms → ISO-8601 UTC (no milliseconds), matching the extractor. */
export function toIsoUtc(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
  );
}

/** Today at 08:00 UTC, ISO-8601 no milliseconds — a friendly default. */
export function isoNowAt8(): string {
  const d = new Date();
  d.setUTCHours(8, 0, 0, 0);
  return toIsoUtc(d.getTime());
}

/**
 * Reconcile scheduleStart / scheduleFinish / scheduleDuration so any
 * two-of-three the caller supplies produce a consistent third.
 *   • If start + finish supplied → derive duration from their delta.
 *   • If start + duration → derive finish.
 *   • If finish + duration (no start) → leave as-is; no start to anchor.
 *   • Otherwise return patched merge as-is.
 * Returns null when finish < start (invalid, caller should reject).
 */
export function reconcileTaskTime(
  merged: { scheduleStart?: string; scheduleFinish?: string; scheduleDuration?: string }
    & Record<string, unknown>,
): typeof merged | null {
  const start = parseIsoDate(merged.scheduleStart as string | undefined);
  const finish = parseIsoDate(merged.scheduleFinish as string | undefined);
  if (start !== undefined && finish !== undefined && finish < start) return null;

  if (start !== undefined && finish !== undefined) {
    merged.scheduleDuration = msToIsoDuration(finish - start);
  } else if (start !== undefined && merged.scheduleDuration) {
    const finishMs = addIsoDurationToEpoch(start, merged.scheduleDuration);
    if (finishMs !== undefined) merged.scheduleFinish = toIsoUtc(finishMs);
  }
  return merged;
}

// ═════════════════════════════════════════════════════════════════════
// Extraction clone
// ═════════════════════════════════════════════════════════════════════

/** Deep-clone an extraction so snapshots don't share mutable refs. */
export function cloneExtraction(src: ScheduleExtraction): ScheduleExtraction {
  // `structuredClone` is available in every runtime we target. Falls
  // back to JSON only if the environment is ancient — the tasks /
  // sequences are plain data so both paths round-trip cleanly.
  if (typeof structuredClone === 'function') return structuredClone(src);
  return JSON.parse(JSON.stringify(src)) as ScheduleExtraction;
}

// ═════════════════════════════════════════════════════════════════════
// Federation helpers — translate renderer globals ↔ local expressIds
// ═════════════════════════════════════════════════════════════════════

/** Pick the only model when running single-model; null otherwise. */
export function resolveSingleModelId(
  state: { models?: Map<string, unknown> },
): string | null {
  const models = state.models;
  if (!models || models.size !== 1) return null;
  const firstKey = models.keys().next().value;
  return typeof firstKey === 'string' ? firstKey : null;
}

export function resolveIdOffset(
  state: { models?: Map<string, { idOffset?: number }> },
  sourceModelId: string | null,
): number {
  if (!sourceModelId) return 0;
  return state.models?.get(sourceModelId)?.idOffset ?? 0;
}

/**
 * Standard "which model does this schedule attach to?" resolution: prefer
 * the currently-active model; fall back to the only model in single-model
 * sessions; otherwise return `emptyFallback` (defaults to `''`).
 *
 * Extracted so every schedule-pipeline site uses the same rule — previously
 * the `activeModelId ?? (models.size === 1 ? ... : '')` snippet was
 * duplicated across 6 files, inviting drift.
 */
export function resolveScheduleSourceModelId<M>(
  models: ReadonlyMap<string, M>,
  activeModelId: string | null | undefined,
  emptyFallback: string = '',
): string {
  if (activeModelId) return activeModelId;
  if (models.size === 1) {
    const first = models.keys().next().value;
    return typeof first === 'string' ? first : emptyFallback;
  }
  return emptyFallback;
}
