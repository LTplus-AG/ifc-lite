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
  type ClashRulePreset,
  type ClashMode,
  type ClashSeverity,
} from '@ifc-lite/clash';
import { downloadFile } from '../export/download.js';

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
  | { ok: false; reason: 'quota' | 'serialize' | 'too_many'; message: string };

const PRESETS_KEY = 'ifc-lite-clash-presets';
const SETTINGS_KEY = 'ifc-lite-clash-settings';
const SCHEMA_VERSION = 1;

const MAX_PRESETS = 200;
const MAX_NAME = 100;

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

const BUILTIN_PRESET_IDS = new Set(CLASH_RULE_PRESETS.map((p) => p.id));
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
    const raw = localStorage.getItem(PRESETS_KEY);
    if (!raw) return [];
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
        builtin: BUILTIN_PRESET_IDS.has(p.id),
      }));
  } catch {
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
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_CLASH_SETTINGS };
    return normalizeSettings(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_CLASH_SETTINGS };
  }
}

export function saveSettings(settings: ClashGlobalSettings): SaveResult {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ schemaVersion: SCHEMA_VERSION, settings }));
    return { ok: true };
  } catch {
    return { ok: false, reason: 'quota', message: 'Browser storage is full — clash settings were not saved.' };
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
    builtin: BUILTIN_PRESET_IDS.has(p.id),
  }));
  return { presets: mergeStoredPresets(stored), settings: normalizeSettings(b.settings) };
}
