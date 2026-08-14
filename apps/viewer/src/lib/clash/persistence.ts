/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * localStorage persistence for clash detection settings + the user's rule preset
 * set. Mirrors the lens slice's "built-ins + overrides + custom" model and the
 * scripts module's quota-safe `SaveResult`:
 *
 * - Presets: the built-in `CLASH_RULE_PRESETS` are always present (projected to
 *   editable items with `enabled`/`builtin`); the user may toggle/edit them
 *   (stored as overrides) and add custom presets. Only customs + modified
 *   built-ins are persisted, so shipping a new built-in just works.
 * - Settings: one flat JSON blob (mode/tolerance/clearance/clusterEpsilon/
 *   reportTouch/groupBy), every numeric clamped to a sane range on load.
 */

import {
  CLASH_RULE_PRESETS,
  CLASH_REVIEW_STATUSES,
  DEFAULT_CLASH_REVIEW_STATUS,
  type ClashRulePreset,
  type ClashMode,
  type ClashReview,
  type ClashReviewStatus,
  type ClashSeverity,
} from '@ifc-lite/clash';
import {
  MAX_EXCLUSION_LABEL,
  type ClashExclusionKind,
  type ClashExclusionRule,
} from './exclusions.js';
import { downloadFile } from '../export/download.js';
import { optionalLocalStorage, preserveUnreadableEntry } from '../storage/unreadable-entry.js';

/** A built-in or user-defined clash rule preset, with editor/runtime flags. */
export type ClashPreset = ClashRulePreset & { enabled: boolean; builtin: boolean };

/** How the panel groups the flat clash list (display only). */
export type ClashSettingsGroupBy = 'severity' | 'rule' | 'typePair';

/** Global detection settings, persisted as one blob. */
export interface ClashGlobalSettings {
  mode: ClashMode;
  tolerance: number;
  clearance: number;
  clusterEpsilon: number;
  reportTouch: boolean;
  groupBy: ClashSettingsGroupBy;
}

export type SaveResult =
  | { ok: true }
  | { ok: false; reason: 'quota' | 'serialize' | 'too_many' | 'unreadable'; message: string };

const PRESETS_KEY = 'ifc-lite-clash-presets';
const SETTINGS_KEY = 'ifc-lite-clash-settings';
/** Per-clash review status + comments, keyed by the durable `clashReviewKey`. (#1468) */
const REVIEWS_KEY = 'ifc-lite-clash-reviews';
/** The user's own "these two may overlap" rules (type pairs + element pairs). */
const EXCLUSIONS_KEY = 'ifc-lite-clash-exclusions';
const SCHEMA_VERSION = 1;

const MAX_PRESETS = 200;
const MAX_NAME = 100;
/** Cap on stored reviews so a huge model can't blow the localStorage quota. */
const MAX_REVIEWS = 10_000;
/** Cap on a single review comment; longer notes belong in a real issue tracker. */
const MAX_COMMENT = 2_000;
/** Cap on stored exclusion rules. Type-pair rules keep the realistic count low. */
const MAX_EXCLUSIONS = 2_000;

/** [min, max] clamps applied to settings numerics on load and on commit. */
export const CLASH_BOUNDS = {
  tolerance: [0, 1] as const,
  clearance: [0, 5] as const,
  clusterEpsilon: [0.01, 50] as const,
};

export const DEFAULT_CLASH_SETTINGS: ClashGlobalSettings = {
  mode: 'hard',
  tolerance: 0.002,
  clearance: 0.05,
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
function builtinPresetIds(): Set<string> {
  return (builtinPresetIdsCache ??= new Set(CLASH_RULE_PRESETS.map((p) => p.id)));
}

/**
 * Keys whose stored value we failed to read *and* failed to move aside. Both
 * loaders below degrade to defaults on a read failure, so without this the next
 * ordinary edit would serialize those defaults over data we never managed to
 * see. Entries are added by the loader and cleared by a later clean read.
 */
const unwritableKeys = new Set<string>();

/** Handle a loader throwing: preserve what is stored, or block writes to `key`. */
function onReadFailure(key: string, cause: unknown): void {
  if (preserveUnreadableEntry(optionalLocalStorage(), key, cause)) unwritableKeys.delete(key);
  else unwritableKeys.add(key);
}

/** A refusal to overwrite a value we could neither read nor preserve. */
function refuseOverwrite(what: string): SaveResult {
  return {
    ok: false,
    reason: 'unreadable',
    message: `Stored ${what} could not be read and could not be backed up — they were left untouched.`,
  };
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

function isValidStoredPreset(p: unknown): p is ClashPreset {
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

/** Read stored presets, accepting the versioned wrapper or a legacy bare array. */
function readStoredPresets(): ClashPreset[] {
  try {
    unwritableKeys.delete(PRESETS_KEY);
    const raw = localStorage.getItem(PRESETS_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    const list = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === 'object' && Array.isArray((parsed as { presets?: unknown }).presets)
        ? (parsed as { presets: unknown[] }).presets
        : [];
    return list
      .filter(isValidStoredPreset)
      .map((p) => ({
        id: p.id,
        name: p.name,
        description: typeof p.description === 'string' ? p.description : '',
        severity: p.severity,
        selectorA: p.selectorA,
        selectorB: p.selectorB,
        enabled: p.enabled !== false,
        builtin: builtinPresetIds().has(p.id),
      }));
  } catch (err) {
    onReadFailure(PRESETS_KEY, err);
    return [];
  }
}

/** The pristine built-in preset set, no overrides/customs — the "reset" target. */
export function defaultPresets(): ClashPreset[] {
  return CLASH_RULE_PRESETS.map((p) => ({ ...p, enabled: true, builtin: true }));
}

/**
 * The full preset list shown to the user: every built-in (with any saved
 * override applied) followed by custom presets. Built-ins are always present
 * even if storage is empty or dropped them.
 */
/**
 * Resolve a stored (customs + modified-built-ins) list into the full preset
 * list: every built-in (with any override applied), then customs. Built-ins are
 * always present, so a list from an older app version still picks up new ones.
 */
export function mergeStoredPresets(stored: ClashPreset[]): ClashPreset[] {
  const overrides = new Map(stored.filter((p) => p.builtin).map((p) => [p.id, p]));
  const builtins: ClashPreset[] = CLASH_RULE_PRESETS.map(
    (p) => overrides.get(p.id) ?? { ...p, enabled: true, builtin: true },
  );
  const custom = stored.filter((p) => !p.builtin);
  return [...builtins, ...custom];
}

export function buildInitialPresets(): ClashPreset[] {
  return mergeStoredPresets(readStoredPresets());
}

function builtinDiffersFromDefault(p: ClashPreset): boolean {
  const orig = CLASH_RULE_PRESETS.find((b) => b.id === p.id);
  if (!orig) return true;
  return (
    !p.enabled ||
    p.name !== orig.name ||
    p.severity !== orig.severity ||
    p.selectorA !== orig.selectorA ||
    p.selectorB !== orig.selectorB ||
    p.description !== orig.description
  );
}

/** The minimal stored shape: customs + only the built-ins that differ from default. */
export function presetsToStore(presets: ClashPreset[]): ClashPreset[] {
  return [
    ...presets.filter((p) => !p.builtin),
    ...presets.filter((p) => p.builtin && builtinDiffersFromDefault(p)),
  ];
}

/** Persist only custom presets + modified built-ins (quota-safe). */
export function savePresets(presets: ClashPreset[]): SaveResult {
  if (unwritableKeys.has(PRESETS_KEY)) return refuseOverwrite('clash rules');
  const custom = presets.filter((p) => !p.builtin);
  if (custom.length > MAX_PRESETS) {
    return { ok: false, reason: 'too_many', message: `Too many custom rules (max ${MAX_PRESETS}).` };
  }
  const toStore = presetsToStore(presets);
  let payload: string;
  try {
    payload = JSON.stringify({ schemaVersion: SCHEMA_VERSION, presets: toStore });
  } catch {
    return { ok: false, reason: 'serialize', message: 'Could not serialize clash rules.' };
  }
  try {
    localStorage.setItem(PRESETS_KEY, payload);
    return { ok: true };
  } catch {
    return { ok: false, reason: 'quota', message: 'Browser storage is full — clash rules were not saved.' };
  }
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
    clusterEpsilon: clampToBounds(s.clusterEpsilon, CLASH_BOUNDS.clusterEpsilon, DEFAULT_CLASH_SETTINGS.clusterEpsilon),
    reportTouch: s.reportTouch === true,
    groupBy: GROUP_BYS.includes(s.groupBy as ClashSettingsGroupBy) ? (s.groupBy as ClashSettingsGroupBy) : 'severity',
  };
}

export function loadSettings(): ClashGlobalSettings {
  try {
    unwritableKeys.delete(SETTINGS_KEY);
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw === null) return { ...DEFAULT_CLASH_SETTINGS };
    return normalizeSettings(JSON.parse(raw));
  } catch (err) {
    onReadFailure(SETTINGS_KEY, err);
    return { ...DEFAULT_CLASH_SETTINGS };
  }
}

export function saveSettings(settings: ClashGlobalSettings): SaveResult {
  if (unwritableKeys.has(SETTINGS_KEY)) return refuseOverwrite('clash settings');
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ schemaVersion: SCHEMA_VERSION, settings }));
    return { ok: true };
  } catch {
    return { ok: false, reason: 'quota', message: 'Browser storage is full — clash settings were not saved.' };
  }
}

// Per-clash review state (status + comment).
// The coordinator's triage on a clash (open / resolved / accepted, plus an
// optional note), keyed by the DURABLE `clashReviewKey` from `@ifc-lite/clash`
// so it re-attaches across reloads, re-runs and model revisions. Default-state
// reviews (open, no comment) are pruned on save so storage holds only real
// decisions and stays quota-lean. (#1468)

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

/** Read stored reviews into a Map keyed by durable clash-review key. */
export function loadReviews(): Map<string, ClashReview> {
  const map = new Map<string, ClashReview>();
  try {
    unwritableKeys.delete(REVIEWS_KEY);
    const raw = localStorage.getItem(REVIEWS_KEY);
    if (raw === null) return map;
    const parsed: unknown = JSON.parse(raw);
    const reviews =
      parsed && typeof parsed === 'object' ? (parsed as { reviews?: unknown }).reviews : null;
    if (!reviews || typeof reviews !== 'object') return map;
    for (const [key, value] of Object.entries(reviews as Record<string, unknown>)) {
      if (!key || !value || typeof value !== 'object') continue;
      const r = value as Record<string, unknown>;
      if (!isReviewStatus(r.status)) continue;
      const comment = normalizeComment(r.comment);
      const review: ClashReview = {
        status: r.status,
        ...(comment ? { comment } : {}),
        ...(typeof r.updatedAt === 'number' && Number.isFinite(r.updatedAt) ? { updatedAt: r.updatedAt } : {}),
      };
      // Skip default entries a stale writer may have left behind.
      if (isMeaningfulReview(review)) map.set(key, review);
    }
  } catch (err) {
    // A half-built map is as destructive as an empty one: the next triage edit
    // writes it back and the entries we never parsed are gone. (#2085)
    map.clear();
    onReadFailure(REVIEWS_KEY, err);
    return map;
  }
  return map;
}

/** Persist reviews (default-state entries pruned, capped, quota-safe). */
export function saveReviews(reviews: Map<string, ClashReview>): SaveResult {
  if (unwritableKeys.has(REVIEWS_KEY)) return refuseOverwrite('clash reviews');
  const entries: Record<string, ClashReview> = {};
  let count = 0;
  for (const [key, review] of reviews) {
    if (!isMeaningfulReview(review)) continue;
    if (count >= MAX_REVIEWS) {
      return { ok: false, reason: 'too_many', message: `Too many clash reviews (max ${MAX_REVIEWS}).` };
    }
    entries[key] = review;
    count += 1;
  }
  let payload: string;
  try {
    payload = JSON.stringify({ schemaVersion: SCHEMA_VERSION, reviews: entries });
  } catch {
    return { ok: false, reason: 'serialize', message: 'Could not serialize clash reviews.' };
  }
  try {
    localStorage.setItem(REVIEWS_KEY, payload);
    return { ok: true };
  } catch {
    return { ok: false, reason: 'quota', message: 'Browser storage is full; clash reviews were not saved.' };
  }
}

// User-defined clash exclusions.
// A coordinator's decision that a given overlap is by design (ballast around a
// rail, a girder cast into a deck). Persisted as workspace state alongside
// presets and reviews — never wiped by a re-run or by `clearClash`, because the
// decision outlives any one detection run. Rule semantics live in
// `./exclusions.ts`; this section only reads and writes them.

// A rule whose `kind` this build does not know is dropped rather than guessed
// at: the safe failure for a suppression rule is to show the clashes, never to
// hide something on a semantics we cannot read.
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

/** Read stored exclusion rules; an unreadable entry blocks writes, never a silent reset. */
export function loadExclusions(): ClashExclusionRule[] {
  try {
    unwritableKeys.delete(EXCLUSIONS_KEY);
    const raw = localStorage.getItem(EXCLUSIONS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    const list =
      parsed && typeof parsed === 'object' && Array.isArray((parsed as { exclusions?: unknown }).exclusions)
        ? (parsed as { exclusions: unknown[] }).exclusions
        : [];
    return list.filter(isValidStoredExclusion).map((r) => ({
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
      enabled: r.enabled !== false,
      createdAt: typeof r.createdAt === 'number' && Number.isFinite(r.createdAt) ? r.createdAt : 0,
    }));
  } catch (err) {
    onReadFailure(EXCLUSIONS_KEY, err);
    return [];
  }
}

/** Persist the exclusion rule list (capped, quota-safe). */
export function saveExclusions(rules: readonly ClashExclusionRule[]): SaveResult {
  if (unwritableKeys.has(EXCLUSIONS_KEY)) return refuseOverwrite('clash exclusions');
  if (rules.length > MAX_EXCLUSIONS) {
    return { ok: false, reason: 'too_many', message: `Too many clash exclusions (max ${MAX_EXCLUSIONS}).` };
  }
  let payload: string;
  try {
    payload = JSON.stringify({ schemaVersion: SCHEMA_VERSION, exclusions: rules });
  } catch {
    return { ok: false, reason: 'serialize', message: 'Could not serialize clash exclusions.' };
  }
  try {
    localStorage.setItem(EXCLUSIONS_KEY, payload);
    return { ok: true };
  } catch {
    return { ok: false, reason: 'quota', message: 'Browser storage is full — clash exclusions were not saved.' };
  }
}

/** Download the user's presets (customs + modified built-ins) as a JSON file. */
export function exportPresets(presets: ClashPreset[]): void {
  const custom = presets.filter((p) => !p.builtin || builtinDiffersFromDefault(p));
  const json = JSON.stringify({ schemaVersion: SCHEMA_VERSION, presets: custom }, null, 2);
  downloadFile(json, 'clash-rules.clash-presets.json', 'application/json');
}

/** Parse an exported file into custom presets (ids regenerated, `builtin` stripped). */
export async function importPresets(file: File): Promise<ClashPreset[]> {
  const text = await file.text();
  const parsed: unknown = JSON.parse(text);
  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { presets?: unknown }).presets)
      ? (parsed as { presets: unknown[] }).presets
      : [];
  return list.filter(isValidStoredPreset).map((p) => ({
    id: `custom-${crypto.randomUUID()}`,
    name: p.name.slice(0, MAX_NAME),
    description: typeof p.description === 'string' ? p.description : '',
    severity: p.severity,
    selectorA: p.selectorA,
    selectorB: p.selectorB,
    enabled: p.enabled !== false,
    builtin: false,
  }));
}

// ── Flavor integration ───────────────────────────────────────────────────────
// Clash config rides inside a flavor's generic `settings.clash` blob, so each
// flavor/profile carries its own rule-set + detection settings (and they travel
// with flavor export/import). Serialize stores the minimal shape (customs +
// modified built-ins + settings); deserialize rebuilds the full, validated state.

/** Plain-JSON snapshot of clash config stored in a flavor. */
export interface ClashFlavorConfig {
  schemaVersion: number;
  settings: ClashGlobalSettings;
  /** Customs + modified built-ins only (built-ins are re-merged on restore). */
  presets: ClashPreset[];
}

export function serializeClashConfig(presets: ClashPreset[], settings: ClashGlobalSettings): ClashFlavorConfig {
  return { schemaVersion: SCHEMA_VERSION, settings: { ...settings }, presets: presetsToStore(presets) };
}

/**
 * Rebuild clash state from a flavor blob: the full resolved preset list (defaults
 * + the blob's overrides/customs) and bounds-clamped settings. Returns null when
 * the blob is missing/garbage so the caller can skip the restore.
 */
export function deserializeClashConfig(blob: unknown): { presets: ClashPreset[]; settings: ClashGlobalSettings } | null {
  if (!blob || typeof blob !== 'object') return null;
  const b = blob as Partial<ClashFlavorConfig>;
  const storedRaw = Array.isArray(b.presets) ? b.presets : [];
  const stored = storedRaw.filter(isValidStoredPreset).map((p) => ({
    id: p.id,
    name: p.name,
    description: typeof p.description === 'string' ? p.description : '',
    severity: p.severity,
    selectorA: p.selectorA,
    selectorB: p.selectorB,
    enabled: p.enabled !== false,
    builtin: builtinPresetIds().has(p.id),
  }));
  return { presets: mergeStoredPresets(stored), settings: normalizeSettings(b.settings) };
}
