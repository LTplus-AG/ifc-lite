/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  CLASH_RULE_PRESETS, CLASH_REVIEW_STATUSES, DEFAULT_CLASH_REVIEW_STATUS,
  type ClashRulePreset, type ClashMode, type ClashReview, type ClashReviewStatus, type ClashSeverity,
} from '@ifc-lite/clash';
import { MAX_EXCLUSION_LABEL, type ClashExclusionKind, type ClashExclusionRule } from './exclusions.js';
import { parseClashSetFilters, type ClashSetFilters } from './set-filter.js';

/**
 * A built-in or user-defined clash rule preset, with editor/runtime flags.
 *
 * `filterA` / `filterB` are the optional advanced-filter definition of each
 * side (#3902). Absent on every preset saved before they existed and on every
 * built-in, which is exactly what makes them additive: a side with no filter
 * keeps resolving through its `selectorA` / `selectorB` type selector.
 */
export type ClashPreset = ClashRulePreset & { enabled: boolean; builtin: boolean } & ClashSetFilters;

/** How the panel groups the flat clash list (display only). */
export type ClashSettingsGroupBy = 'severity' | 'rule' | 'typePair';

/** Global detection settings, persisted as one blob. */
export interface ClashGlobalSettings {
  mode: ClashMode;
  tolerance: number;
  clearance: number;
  /** Duplicate-scan position tolerance (m): how far apart two elements may be
   *  and still count as the same object (`findDuplicates.positionTolerance`).
   *  An upper bound, not the whole gate: the effective tolerance per axis is
   *  `min(this, extent on that axis)` — see `findDuplicates.positionTolerance`.
   *  Distinct from `tolerance`, which is the clash engine's touching band. */
  duplicateTolerance: number;
  clusterEpsilon: number;
  reportTouch: boolean;
  groupBy: ClashSettingsGroupBy;
}

const PRESETS_KEY = 'ifc-lite-clash-presets';
const SETTINGS_KEY = 'ifc-lite-clash-settings';
/** Per-clash review status + comments, keyed by the durable `clashReviewKey`. (#1468) */
const REVIEWS_KEY = 'ifc-lite-clash-reviews';
/** The user's own "these two may overlap" rules (type pairs + element pairs). */
const EXCLUSIONS_KEY = 'ifc-lite-clash-exclusions';
export const SCHEMA_VERSION = 1;

const MAX_PRESETS = 200;
const MAX_NAME = 100;
/** Cap on stored reviews so a huge model can't blow the localStorage quota. */
const MAX_REVIEWS = 10_000;
/** Cap on a single review comment, cut on load; longer notes belong in a real issue tracker. */
export const MAX_COMMENT = 2_000;
/** Cap on stored exclusion rules. Type-pair rules keep the realistic count low. */
const MAX_EXCLUSIONS = 2_000;

/** [min, max] clamps applied to settings numerics on load and on commit. */
export const CLASH_BOUNDS = {
  tolerance: [0, 1] as const,
  clearance: [0, 5] as const,
  duplicateTolerance: [0, 1] as const,
  clusterEpsilon: [0.01, 50] as const,
};

export const DEFAULT_CLASH_SETTINGS: ClashGlobalSettings = {
  mode: 'hard',
  tolerance: 0.002,
  clearance: 0.05,
  duplicateTolerance: 0.01,
  clusterEpsilon: 1.5,
  reportTouch: false,
  groupBy: 'severity',
};

// Lazily memoized so we never touch the cross-package `CLASH_RULE_PRESETS`
// import at module-eval time. Vite 8 / Rolldown does not guarantee that the
// chunk defining `CLASH_RULE_PRESETS` runs before this module's body, so a
// top-level `CLASH_RULE_PRESETS.map(...)` here threw "Cannot read properties
// of undefined" on boot. Deferring to first call sidesteps the chunk
// initialization-order hazard entirely.
let builtinPresetIdsCache: Set<string> | null = null;
export function builtinPresetIds(): Set<string> {
  return (builtinPresetIdsCache ??= new Set(CLASH_RULE_PRESETS.map((p) => p.id)));
}

const SEVERITIES: ClashSeverity[] = ['critical', 'major', 'minor', 'info'];
const GROUP_BYS: ClashSettingsGroupBy[] = ['severity', 'rule', 'typePair'];

export function clampToBounds(value: unknown, [min, max]: readonly [number, number], fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Trim + length-cap a preset name; null if empty (invalid). */
export function validatePresetName(name: string): string | null {
  const t = name.trim();
  return t ? t.slice(0, MAX_NAME) : null;
}

/** Trim a selector; null if empty (invalid). An empty selector matches everything. */
export function validateSelector(selector: string): string | null {
  const t = selector.trim();
  return t ? t : null;
}

export function isValidStoredPreset(p: unknown): p is ClashPreset {
  if (!p || typeof p !== 'object') return false;
  const r = p as Record<string, unknown>;
  return (
    typeof r.id === 'string' && r.id.length > 0 &&
    typeof r.name === 'string' && r.name.trim().length > 0 &&
    typeof r.selectorA === 'string' && r.selectorA.trim().length > 0 &&
    typeof r.selectorB === 'string' && r.selectorB.trim().length > 0 &&
    typeof r.severity === 'string' && SEVERITIES.includes(r.severity as ClashSeverity)
  );
}

/**
 * The one projection from a validated stored preset to a live one. Every read
 * path — localStorage, file import, flavor restore — goes through it, so a
 * field added to `ClashPreset` cannot survive on some of them and vanish on
 * the others (#3902 added two and would otherwise have had to edit three
 * near-identical literals in two files).
 */
export function storedPresetToPreset(p: ClashPreset, builtin: boolean): ClashPreset {
  return {
    id: p.id,
    name: p.name,
    description: typeof p.description === 'string' ? p.description : '',
    severity: p.severity,
    selectorA: p.selectorA,
    selectorB: p.selectorB,
    enabled: p.enabled !== false,
    builtin,
    ...parseClashSetFilters(p),
  };
}

/** Coerce arbitrary input into valid, bounds-clamped settings (defaults on junk). */
export function normalizeSettings(raw: unknown): ClashGlobalSettings {
  const s = (raw && typeof raw === 'object' && 'settings' in raw
    ? (raw as { settings: unknown }).settings
    : raw) as Partial<ClashGlobalSettings> | null;
  if (!s || typeof s !== 'object') return { ...DEFAULT_CLASH_SETTINGS };
  return {
    mode: s.mode === 'clearance' ? 'clearance' : 'hard',
    tolerance: clampToBounds(s.tolerance, CLASH_BOUNDS.tolerance, DEFAULT_CLASH_SETTINGS.tolerance),
    clearance: clampToBounds(s.clearance, CLASH_BOUNDS.clearance, DEFAULT_CLASH_SETTINGS.clearance),
    duplicateTolerance: clampToBounds(s.duplicateTolerance, CLASH_BOUNDS.duplicateTolerance, DEFAULT_CLASH_SETTINGS.duplicateTolerance),
    clusterEpsilon: clampToBounds(s.clusterEpsilon, CLASH_BOUNDS.clusterEpsilon, DEFAULT_CLASH_SETTINGS.clusterEpsilon),
    reportTouch: s.reportTouch === true,
    groupBy: GROUP_BYS.includes(s.groupBy as ClashSettingsGroupBy) ? (s.groupBy as ClashSettingsGroupBy) : 'severity',
  };
}

function normalizeComment(raw: unknown): string {
  return typeof raw === 'string' ? raw.slice(0, MAX_COMMENT) : '';
}

/** A review worth persisting: a non-default status or a non-empty comment. */
export function isMeaningfulReview(review: ClashReview): boolean {
  return review.status !== DEFAULT_CLASH_REVIEW_STATUS || (review.comment ?? '').trim().length > 0;
}

function isReviewStatus(v: unknown): v is ClashReviewStatus {
  return typeof v === 'string' && (CLASH_REVIEW_STATUSES as readonly string[]).includes(v);
}

const EXCLUSION_KINDS: ClashExclusionKind[] = ['typeAny', 'typePair', 'elementPair'];
function isValidStoredExclusion(v: unknown): v is ClashExclusionRule {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.id === 'string' && r.id.length > 0 &&
    typeof r.kind === 'string' && EXCLUSION_KINDS.includes(r.kind as ClashExclusionKind) &&
    typeof r.a === 'string' && r.a.length > 0 &&
    typeof r.b === 'string' && r.b.length > 0
  );
}

/** The entries of a preset export (a bare array, or `{ presets: [...] }`); null for any other shape. */
function presetListOf(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  const presets = value && typeof value === 'object' ? (value as { presets?: unknown }).presets : undefined;
  return Array.isArray(presets) ? presets : null;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function supported(value: unknown): boolean {
  return record(value) && (value.schemaVersion === undefined || value.schemaVersion === SCHEMA_VERSION);
}

export function decodeStoredPresets(value: unknown, guarded = false): ClashPreset[] {
  const list = presetListOf(value);
  const rows = (list ?? []).filter(isValidStoredPreset).map(p => storedPresetToPreset(p, builtinPresetIds().has(p.id)));
  if (guarded && (!list || (!Array.isArray(value) && !supported(value)) || rows.length !== list.length
    || rows.filter(row => !row.builtin).length > MAX_PRESETS || new Set(rows.map(row => row.id)).size !== rows.length)) {
    throw new Error('Invalid stored clash presets');
  }
  return rows;
}

export function decodeStoredSettings(value: unknown): ClashGlobalSettings {
  if (!supported(value) || !record(value)) throw new Error('Invalid stored clash settings');
  const body = Object.hasOwn(value, 'settings') ? value.settings : value;
  if (!record(body) || (body.mode !== 'clearance' && body.mode !== 'hard')) {
    throw new Error('Invalid stored clash settings');
  }
  return normalizeSettings(value);
}

export function decodeStoredReviews(value: unknown, guarded = false): Map<string, ClashReview> {
  const reviews = record(value) && record(value.reviews) ? Object.entries(value.reviews) : null;
  if (guarded && (!supported(value) || !reviews || reviews.length > MAX_REVIEWS)) throw new Error('Invalid stored clash reviews');
  const map = new Map<string, ClashReview>();
  for (const [key, row] of reviews ?? []) {
    if (!key || !record(row) || !isReviewStatus(row.status)) {
      if (guarded) throw new Error('Invalid stored clash review');
      continue;
    }
    const comment = normalizeComment(row.comment);
    const review: ClashReview = {
      status: row.status, ...(comment ? { comment } : {}),
      ...(typeof row.updatedAt === 'number' && Number.isFinite(row.updatedAt) ? { updatedAt: row.updatedAt } : {}),
    };
    if (isMeaningfulReview(review)) map.set(key, review);
  }
  return map;
}

export function decodeStoredExclusions(value: unknown, guarded = false): ClashExclusionRule[] {
  const list = record(value) && Array.isArray(value.exclusions) ? value.exclusions as unknown[] : null;
  const rows = (list ?? []).filter(isValidStoredExclusion);
  if (guarded && (!supported(value) || !list || rows.length !== list.length || rows.length > MAX_EXCLUSIONS
    || new Set(rows.map(row => row.id)).size !== rows.length)) throw new Error('Invalid stored clash exclusions');
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    a: r.a,
    b: r.b,
    // Fallback label for an entry stored without one. A `typeAny` rule
    // repeats its class in `b`, so the pair form would read "X × X" — which
    // is a DIFFERENT rule the panel also offers; spell out the wide one.
    label:
      typeof r.label === 'string' && r.label
        ? r.label.slice(0, MAX_EXCLUSION_LABEL)
        : r.kind === 'typeAny'
          ? `${r.a} × anything`
          : `${r.a} × ${r.b}`,
    // Fail CLOSED on the enabled flag: an exclusion's whole job is to hide
    // clashes, so a corrupted or partially-written entry that loaded as
    // enabled would silently hide real clashes with no signal. Only the
    // literal `true` that `saveExclusions` writes may suppress; anything
    // else keeps the rule visible in the panel but disabled. (#2535)
    enabled: r.enabled === true,
    createdAt: typeof r.createdAt === 'number' && Number.isFinite(r.createdAt) ? r.createdAt : 0,
  }));
}

export {
  PRESETS_KEY, SETTINGS_KEY, REVIEWS_KEY, EXCLUSIONS_KEY, MAX_PRESETS, MAX_NAME, MAX_REVIEWS, MAX_EXCLUSIONS, presetListOf,
};
