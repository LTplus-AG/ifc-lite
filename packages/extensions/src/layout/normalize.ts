/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { JsonValue, ValidationError, ValidationResult } from '../types.js';
import { createDefaultWorkbenchLayout } from './defaults.js';
import type {
  FloatingPanelPlacement,
  PersonalPanelDefinition,
  WorkbenchLayoutState,
  WorkbenchPanelChrome,
  WorkbenchZoneId,
} from './types.js';

const ZONES: WorkbenchZoneId[] = ['left', 'right', 'bottom'];

export function normalizeWorkbenchLayout(input: unknown): WorkbenchLayoutState {
  const base = createDefaultWorkbenchLayout();
  const raw = isPlainObject(input) && isPlainObject(input.state) ? input.state : input;
  if (!isPlainObject(raw) || raw.schemaVersion !== 1) return base;

  const zones = { ...base.zones };
  if (isPlainObject(raw.zones)) {
    for (const zone of ZONES) {
      const value = raw.zones[zone];
      if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
        zones[zone] = dedupe(value);
      }
    }
  }

  const horizontal = readHorizontal(raw, base.sizes.horizontal);
  const bottomHeight = readNumber(raw.sizes, 'bottomHeight', base.sizes.bottomHeight, 120, 1200);
  const collapsed = { ...base.collapsed };
  if (isPlainObject(raw.collapsed)) {
    for (const zone of ZONES) collapsed[zone] = raw.collapsed[zone] === true;
  }

  const activeTabs = { ...base.activeTabs };
  if (isPlainObject(raw.activeTabs)) {
    for (const zone of ZONES) {
      const value = raw.activeTabs[zone];
      if (typeof value === 'string' || value === undefined) activeTabs[zone] = value;
    }
  }

  return {
    schemaVersion: 1,
    baseLayoutId: typeof raw.baseLayoutId === 'string' ? raw.baseLayoutId : base.baseLayoutId,
    zones,
    sizes: { horizontal, bottomHeight },
    collapsed,
    activeTabs,
    floating: readFloating(raw.floating),
    panelChrome: readRecord(raw.panelChrome, isPanelChrome),
    personalPanels: readRecord(raw.personalPanels, isPersonalPanel),
  };
}

export function validateWorkbenchLayout(input: unknown): ValidationResult<WorkbenchLayoutState> {
  const errors: ValidationError[] = [];
  if (!isPlainObject(input)) {
    return { ok: false, errors: [{ path: '', code: 'type_mismatch', message: 'Layout must be an object.' }] };
  }
  if (input.schemaVersion !== 1) {
    errors.push({ path: 'schemaVersion', code: 'invalid_manifest_version', message: 'Unsupported layout schemaVersion.' });
  }
  if (!isPlainObject(input.zones)) {
    errors.push({ path: 'zones', code: 'required', message: 'zones is required.' });
  }
  if (!isPlainObject(input.sizes)) {
    errors.push({ path: 'sizes', code: 'required', message: 'sizes is required.' });
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: normalizeWorkbenchLayout(input) };
}

function readHorizontal(raw: Record<string, unknown>, fallback: [number, number, number]): [number, number, number] {
  const sizes = isPlainObject(raw.sizes) ? raw.sizes.horizontal : undefined;
  if (!Array.isArray(sizes) || sizes.length !== 3) return fallback;
  const next = sizes.map((item) => typeof item === 'number' && Number.isFinite(item) ? item : 0);
  if (next.some((item) => item <= 0)) return fallback;
  return [next[0], next[1], next[2]];
}

function readNumber(raw: unknown, key: string, fallback: number, min: number, max: number): number {
  if (!isPlainObject(raw)) return fallback;
  const value = raw[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function readFloating(raw: unknown): FloatingPanelPlacement[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isFloating);
}

function readRecord<T>(raw: unknown, guard: (value: unknown) => value is T): Record<string, T> {
  if (!isPlainObject(raw)) return {};
  const out: Record<string, T> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (guard(value)) out[key] = value;
  }
  return out;
}

function isPanelChrome(value: unknown): value is WorkbenchPanelChrome {
  if (!isPlainObject(value)) return false;
  return ['title', 'icon', 'accent'].every((key) => value[key] === undefined || typeof value[key] === 'string')
    && (value.hidden === undefined || typeof value.hidden === 'boolean');
}

function isPersonalPanel(value: unknown): value is PersonalPanelDefinition {
  return isPlainObject(value)
    && typeof value.id === 'string'
    && typeof value.title === 'string'
    && isJsonValue(value.widget)
    && typeof value.createdAt === 'string'
    && typeof value.updatedAt === 'string';
}

function isFloating(value: unknown): value is FloatingPanelPlacement {
  return isPlainObject(value)
    && typeof value.panelId === 'string'
    && ['x', 'y', 'width', 'height'].every((key) => typeof value[key] === 'number');
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true;
  if (['string', 'number', 'boolean'].includes(typeof value)) return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (!isPlainObject(value)) return false;
  return Object.values(value).every(isJsonValue);
}

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
