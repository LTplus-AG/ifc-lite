/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** One persisted Lens normalization path for localStorage, JSON import and
 * flavor snapshots (#5896). The old editor import validator is removed in the
 * final cleanup step of this stack. */
import { AUTO_COLOR_SOURCES, type AutoColorSpec, type Lens, type LensRule } from '@ifc-lite/lens';
import { migrateSavedLensRule } from './migrate-saved-lens-rule.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isAutoColor(value: unknown): value is AutoColorSpec {
  if (!isRecord(value) || typeof value.source !== 'string'
    || !(AUTO_COLOR_SOURCES as readonly string[]).includes(value.source)) return false;
  if (value.psetName !== undefined && typeof value.psetName !== 'string') return false;
  if (value.propertyName !== undefined && typeof value.propertyName !== 'string') return false;
  if (value.includeUnclassified !== undefined && typeof value.includeUnclassified !== 'boolean') return false;
  return true;
}

function areRules(rules: (LensRule | null)[]): rules is LensRule[] {
  return rules.every((rule) => rule !== null);
}

export function migrateSavedLens(value: unknown): (Omit<Lens, 'id'> & { id?: string }) | null {
  if (!isRecord(value) || typeof value.name !== 'string' || value.name.length === 0
    || !Array.isArray(value.rules)
    || (value.autoColor !== undefined && !isAutoColor(value.autoColor))) return null;
  const rules = value.rules.map(migrateSavedLensRule);
  if (!areRules(rules)) return null;
  return {
    ...(typeof value.id === 'string' && value.id.length > 0 ? { id: value.id } : {}),
    name: value.name,
    rules,
    ...(value.autoColor ? { autoColor: { ...value.autoColor } } : {}),
  };
}

/** Upsert imports without discarding built-in status or existing order. */
export function mergeImportedGroupLenses(
  existing: readonly Lens[],
  imported: readonly unknown[],
  generateId: (index: number) => string,
): Lens[] {
  const byId = new Map(existing.map((lens) => [lens.id, lens]));
  const order = existing.map((lens) => lens.id);
  imported.forEach((input, index) => {
    const normalized = migrateSavedLens(input);
    if (!normalized) return;
    const id = normalized.id ?? generateId(index);
    const prior = byId.get(id);
    const merged: Lens = {
      id, name: normalized.name, rules: normalized.rules,
      builtin: prior?.builtin ?? false,
      ...(normalized.autoColor ? { autoColor: normalized.autoColor } : {}),
    };
    if (!byId.has(id)) order.push(id);
    byId.set(id, merged);
  });
  return order.map((id) => byId.get(id)!);
}
