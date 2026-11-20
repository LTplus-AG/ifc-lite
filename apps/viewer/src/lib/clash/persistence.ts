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
 * - Settings: one flat JSON blob (mode/tolerance/clearance/duplicateTolerance/
 *   clusterEpsilon/reportTouch/groupBy), every numeric clamped to a sane range
 *   on load.
 */

import { trackExportCompleted } from '@/lib/analytics';
import { CLASH_RULE_PRESETS, type ClashReview } from '@ifc-lite/clash';
import type { ClashExclusionRule } from './exclusions.js';
import {
  DEFAULT_CLASH_SETTINGS, EXCLUSIONS_KEY, MAX_EXCLUSIONS, MAX_NAME, MAX_PRESETS, MAX_REVIEWS, PRESETS_KEY, REVIEWS_KEY,
  SCHEMA_VERSION, SETTINGS_KEY, decodeStoredExclusions, decodeStoredPresets, decodeStoredReviews, encodeStoredReviews, isMeaningfulReview,
  isValidStoredPreset, normalizeSettings, presetListOf, storedPresetToPreset,
  type ClashGlobalSettings, type ClashPreset,
} from './persistence-codecs.js';
export {
  CLASH_BOUNDS, DEFAULT_CLASH_SETTINGS, MAX_COMMENT, MAX_PRESETS, SCHEMA_VERSION, builtinPresetIds, clampToBounds, isMeaningfulReview,
  isValidStoredPreset, normalizeSettings, storedPresetToPreset, validatePresetName, validateSelector,
  type ClashGlobalSettings, type ClashPreset, type ClashSettingsGroupBy,
} from './persistence-codecs.js';
import { downloadFile } from '../export/download.js';
import { optionalLocalStorage, preserveUnreadableEntry } from '../storage/unreadable-entry.js';

/**
 * Why a save was refused.
 *
 * `rollback_failed` is the odd one out: no writer in this module returns it.
 * It is raised by a caller that writes more than one key and could not undo
 * the half that landed after a later write was refused (see
 * `applyClashFlavorConfig` in `clashSlice.ts`). The others all mean "nothing
 * changed"; this one means storage is now holding a mix the user never chose,
 * so it is the one value a caller must be able to tell apart without reading
 * the message.
 *
 * A failed undo is necessary but not sufficient: if the write being undone
 * stored the same rule set that was already stored, nothing was stranded and
 * the caller reports the refused write's own reason instead. See
 * `presetsStoreIdentically`.
 */
export type ClashSaveFailureReason =
  | 'quota'
  | 'serialize'
  | 'too_many'
  | 'unreadable'
  | 'rollback_failed';

export type SaveResult =
  | { ok: true }
  | { ok: false; reason: ClashSaveFailureReason; message: string };

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

/** Read stored presets, accepting the versioned wrapper or a legacy bare array. */
function readStoredPresets(): ClashPreset[] {
  try {
    unwritableKeys.delete(PRESETS_KEY);
    const raw = localStorage.getItem(PRESETS_KEY);
    if (raw === null) return [];
    return decodeStoredPresets(JSON.parse(raw));
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
    !!p.filterA || !!p.filterB ||
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

/**
 * The exact string `savePresets` hands to `localStorage.setItem`, or null if
 * the rule set cannot be serialized. The single source of those bytes, so a
 * caller comparing two rule sets compares what would actually be written.
 */
function presetsPayload(presets: ClashPreset[]): string | null {
  try {
    return JSON.stringify({ schemaVersion: SCHEMA_VERSION, presets: presetsToStore(presets) });
  } catch {
    return null;
  }
}

/**
 * Whether storing `a` and storing `b` would write the same bytes under the
 * presets key — i.e. whether replacing `a` with `b` leaves the store's
 * serialized form unchanged.
 *
 * Not the same question as "would the bytes on disk change": `readStoredPresets`
 * also accepts a legacy bare array, so the key can already be in sync with a
 * value that is not what `savePresets` writes, and storing either of these rule
 * sets over it would rewrite it into the current wrapper. What this answers is
 * that both rule sets persist as the same thing, so whichever one lands, a
 * reload rebuilds the same state.
 *
 * Built through `presetsPayload`, the same function `savePresets` writes from,
 * so this cannot drift from the real payload the way a structural or reference
 * comparison could: `presetsToStore` drops built-ins that match their default,
 * so two rule sets that differ as arrays can still store identically.
 *
 * A rule set that fails to serialize is reported as differing from everything,
 * including itself: nothing can be concluded about bytes that cannot be built.
 */
export function presetsStoreIdentically(a: ClashPreset[], b: ClashPreset[]): boolean {
  const payloadA = presetsPayload(a);
  return payloadA !== null && payloadA === presetsPayload(b);
}

/** Persist only custom presets + modified built-ins (quota-safe). */
export function savePresets(presets: ClashPreset[]): SaveResult {
  if (unwritableKeys.has(PRESETS_KEY)) return refuseOverwrite('clash rules');
  const custom = presets.filter((p) => !p.builtin);
  if (custom.length > MAX_PRESETS) {
    return { ok: false, reason: 'too_many', message: `Too many custom rules (max ${MAX_PRESETS}).` };
  }
  const payload = presetsPayload(presets);
  if (payload === null) {
    return { ok: false, reason: 'serialize', message: 'Could not serialize clash rules.' };
  }
  try {
    localStorage.setItem(PRESETS_KEY, payload);
    return { ok: true };
  } catch {
    return { ok: false, reason: 'quota', message: 'Browser storage is full — clash rules were not saved.' };
  }
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

/**
 * The exact string `saveSettings` hands to `localStorage.setItem`. The single
 * source of those bytes, so a caller asking whether a settings write would
 * change anything compares what would actually be written.
 *
 * The settings object is rebuilt here, field by field, rather than serialized
 * as handed in: `JSON.stringify` takes its key order from its input, so
 * stringifying the caller's object would put that order — not this function —
 * in charge of the bytes. The two settings objects production compares are
 * built by two unshared literals in two files (`snapshotSettings` in
 * `store/slices/clashSlice.ts` builds what is written; `normalizeSettings`
 * below builds what a flavor carries, via `deserializeClashConfig`), and they
 * matched only by convention. Reorder either literal and every "is this
 * already stored?" answer flips to `false` forever, with nothing to catch it.
 *
 * Rebuilding here makes the order this function's own, so both sides of any
 * comparison — and the write itself — serialize the same way regardless of how
 * their object was assembled. The annotation, not `satisfies`, is deliberate: a
 * field added to `ClashGlobalSettings` and forgotten here is a compile error
 * rather than a field silently dropped from storage.
 */
function settingsPayload(settings: ClashGlobalSettings): string {
  const canonical: ClashGlobalSettings = {
    mode: settings.mode,
    tolerance: settings.tolerance,
    clearance: settings.clearance,
    duplicateTolerance: settings.duplicateTolerance,
    clusterEpsilon: settings.clusterEpsilon,
    reportTouch: settings.reportTouch,
    groupBy: settings.groupBy,
  };
  return JSON.stringify({ schemaVersion: SCHEMA_VERSION, settings: canonical });
}

/**
 * Whether the settings key already holds exactly the bytes `saveSettings`
 * would write for `settings` — i.e. whether that write would change nothing.
 *
 * Built through `settingsPayload`, the same function `saveSettings` writes
 * from, so the compared bytes are the written bytes by construction — the key
 * order included, since that builder fixes it rather than inheriting it from
 * whichever object literal produced these settings.
 *
 * One-directional on purpose: `false` only means "not provably a no-op". A
 * stored value that normalizes to these settings through some other encoding
 * (a legacy blob without the wrapper, or one an older build wrote in another
 * key order) answers `false`, because the write really would rewrite the key.
 * A caller uses this to let a refused write pass, and letting one pass that
 * would have changed the stored bytes is the failure that matters.
 */
export function settingsAlreadyStored(settings: ClashGlobalSettings): boolean {
  try {
    return localStorage.getItem(SETTINGS_KEY) === settingsPayload(settings);
  } catch {
    // No storage, or a blocked one: nothing is provably stored.
    return false;
  }
}

export function saveSettings(settings: ClashGlobalSettings): SaveResult {
  if (unwritableKeys.has(SETTINGS_KEY)) return refuseOverwrite('clash settings');
  try {
    localStorage.setItem(SETTINGS_KEY, settingsPayload(settings));
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

/** Read stored reviews into a Map keyed by durable clash-review key. */
export function loadReviews(): Map<string, ClashReview> {
  try {
    unwritableKeys.delete(REVIEWS_KEY);
    const raw = localStorage.getItem(REVIEWS_KEY);
    return raw === null ? new Map() : decodeStoredReviews(JSON.parse(raw));
  } catch (err) {
    onReadFailure(REVIEWS_KEY, err);
    return new Map();
  }
}

/** Persist reviews (default-state entries pruned, capped, quota-safe). */
export function saveReviews(reviews: Map<string, ClashReview>): SaveResult {
  if (unwritableKeys.has(REVIEWS_KEY)) return refuseOverwrite('clash reviews');
  const entries: [string, ClashReview][] = [];
  for (const [key, review] of reviews) {
    if (!isMeaningfulReview(review)) continue;
    if (entries.length >= MAX_REVIEWS) {
      return { ok: false, reason: 'too_many', message: `Too many clash reviews (max ${MAX_REVIEWS}).` };
    }
    entries.push([key, review]);
  }
  let payload: string;
  try {
    payload = encodeStoredReviews(entries);
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
/** Read stored exclusion rules; an unreadable entry blocks writes, never a silent reset. */
export function loadExclusions(): ClashExclusionRule[] {
  try {
    unwritableKeys.delete(EXCLUSIONS_KEY);
    const raw = localStorage.getItem(EXCLUSIONS_KEY);
    if (!raw) return [];
    return decodeStoredExclusions(JSON.parse(raw));
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
export function exportPresets(presets: ClashPreset[], emit: (content: string, filename: string, mime: string) => void = downloadFile): void {
  const custom = presets.filter((p) => !p.builtin || builtinDiffersFromDefault(p));
  const json = JSON.stringify({ schemaVersion: SCHEMA_VERSION, presets: custom }, null, 2);
  emit(json, 'clash-rules.clash-presets.json', 'application/json');
  trackExportCompleted({ format: 'json', surface: 'clash_results' });
}

/** Parse an exported file into custom presets (ids regenerated, `builtin` stripped). */
export async function importPresets(file: File): Promise<ClashPreset[]> {
  const text = await file.text();
  const parsed: unknown = JSON.parse(text);
  return (presetListOf(parsed) ?? []).filter(isValidStoredPreset).map((p) => ({
    ...storedPresetToPreset(p, false),
    id: `custom-${crypto.randomUUID()}`,
    name: p.name.slice(0, MAX_NAME),
  }));
}
