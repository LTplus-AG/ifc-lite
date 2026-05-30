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

export const MAX_PRESETS = 200;
export const MAX_NAME = 100;

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
export function buildInitialPresets(): ClashPreset[] {
  const stored = readStoredPresets();
  const overrides = new Map(stored.filter((p) => p.builtin).map((p) => [p.id, p]));
  const builtins: ClashPreset[] = CLASH_RULE_PRESETS.map(
    (p) => overrides.get(p.id) ?? { ...p, enabled: true, builtin: true },
  );
  const custom = stored.filter((p) => !p.builtin);
  return [...builtins, ...custom];
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

/** Persist only custom presets + modified built-ins (quota-safe). */
export function savePresets(presets: ClashPreset[]): SaveResult {
  const custom = presets.filter((p) => !p.builtin);
  if (custom.length > MAX_PRESETS) {
    return { ok: false, reason: 'too_many', message: `Too many custom rules (max ${MAX_PRESETS}).` };
  }
  const toStore = [...custom, ...presets.filter((p) => p.builtin && builtinDiffersFromDefault(p))];
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

export function loadSettings(): ClashGlobalSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_CLASH_SETTINGS };
    const parsed: unknown = JSON.parse(raw);
    const s = (parsed && typeof parsed === 'object' && 'settings' in parsed
      ? (parsed as { settings: unknown }).settings
      : parsed) as Partial<ClashGlobalSettings> | null;
    if (!s || typeof s !== 'object') return { ...DEFAULT_CLASH_SETTINGS };
    return {
      mode: s.mode === 'clearance' ? 'clearance' : 'hard',
      tolerance: clampToBounds(s.tolerance, CLASH_BOUNDS.tolerance, DEFAULT_CLASH_SETTINGS.tolerance),
      clearance: clampToBounds(s.clearance, CLASH_BOUNDS.clearance, DEFAULT_CLASH_SETTINGS.clearance),
      clusterEpsilon: clampToBounds(s.clusterEpsilon, CLASH_BOUNDS.clusterEpsilon, DEFAULT_CLASH_SETTINGS.clusterEpsilon),
      reportTouch: s.reportTouch === true,
      groupBy: GROUP_BYS.includes(s.groupBy as ClashSettingsGroupBy) ? (s.groupBy as ClashSettingsGroupBy) : 'severity',
    };
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
  const blob = new Blob([JSON.stringify({ schemaVersion: SCHEMA_VERSION, presets: custom }, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'clash-rules.clash-presets.json';
  a.click();
  URL.revokeObjectURL(url);
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
