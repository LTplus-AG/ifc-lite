/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Lens, LensRule, AutoColorSpec } from '@/store/slices/lensSlice';
// Import the value directly from the source package (not via the slice) to avoid
// a circular value import: lensSlice imports the helpers from this module.
import { AUTO_COLOR_SOURCES } from '@ifc-lite/lens';
import { migrateSavedLensRule } from '@/lib/lens/migrate-saved-lens-rule';

/**
 * Build the {@link Lens} to persist from an auto-color editor session.
 *
 * When editing an existing lens (`initial.id` present) the id MUST be
 * preserved so the save updates that lens in place. Only a brand-new lens
 * (no `initial.id`) gets a freshly generated id. Regenerating the id on
 * every save turned edits into duplicate lenses and made renaming a saved
 * auto-color lens impossible (#1365).
 */
export function buildAutoColorLensToSave(
  initial: { id?: string },
  values: { name: string; autoColor: AutoColorSpec },
  generateId: () => string,
): Lens {
  return {
    id: initial.id ?? generateId(),
    name: values.name,
    rules: [],
    autoColor: values.autoColor,
  };
}

/** Deep-clone editable groups and preserved unreadable legacy data. */
export function cloneLensRules(rules: readonly LensRule[]): LensRule[] {
  return rules.map((rule) => structuredClone(rule));
}

/**
 * Build an editable copy of a lens.
 *
 * The copy gets a fresh id, a "(copy)" suffix, and (crucially) drops the
 * `builtin` flag so it can be edited and deleted - duplicating a built-in
 * preset is how the user gets an editable starting point (e.g. add CLADDING
 * to a copy of "Building Envelope"). Rule ids are regenerated and the
 * groups are deep-cloned so editing the copy never mutates the source. (#1403)
 */
export function duplicateLensConfig(lens: Lens, generateId: () => string): Lens {
  const newId = generateId();
  const copy: Lens = {
    id: newId,
    name: `${lens.name} (copy)`,
    rules: cloneLensRules(lens.rules).map((r, i) => ({ ...r, id: `${newId}-rule-${i}` })),
  };
  if (lens.autoColor) copy.autoColor = { ...lens.autoColor };
  return copy;
}

/** An unreadable imported rule must remain saveable so editing its Lens does
 * not silently discard the raw criterion that the warning explains. */
export function isRuleValid(rule: LensRule): boolean {
  return !!rule.unreadableLegacy || rule.groups.some((group) => group.rules.length > 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Validate an auto-color spec from imported JSON (source must be a known
 *  source; the optional name fields must be strings if present). */
function isImportableAutoColor(item: unknown): item is AutoColorSpec {
  if (!isRecord(item)) return false;
  if (typeof item.source !== 'string'
    || !(AUTO_COLOR_SOURCES as readonly string[]).includes(item.source)) return false;
  if (item.psetName !== undefined && typeof item.psetName !== 'string') return false;
  if (item.propertyName !== undefined && typeof item.propertyName !== 'string') return false;
  // `includeUnclassified` (classification "unclassified bucket" opt-in) must
  // be a boolean if present. A malformed value (string "true", 1, ...) fails
  // the whole spec closed rather than being coerced — same discipline as the
  // other fields above.
  if (item.includeUnclassified !== undefined && typeof item.includeUnclassified !== 'boolean') return false;
  return true;
}

/** A single lens shape accepted by the JSON importer. Rules and the optional
 *  auto-color spec are fully shape-checked so a hand-edited/corrupt file cannot
 *  push malformed entries (`rules: [null]`, `autoColor: []`) into the store. */
function isImportableLens(item: unknown): item is { id?: unknown; name: string; rules: unknown[]; autoColor?: AutoColorSpec } {
  if (!isRecord(item)) return false;
  return typeof item.name === 'string'
    && item.name.length > 0
    && Array.isArray(item.rules)
    && (item.autoColor === undefined || isImportableAutoColor(item.autoColor));
}

function allRulesReadable(rules: (LensRule | null)[]): rules is LensRule[] {
  return rules.every((rule) => rule !== null);
}

/** One normalization point for localStorage, JSON import and flavor snapshots. */
export function migrateSavedLens(item: unknown): (Omit<Lens, 'id'> & { id?: string }) | null {
  if (!isImportableLens(item)) return null;
  const rules = item.rules.map(migrateSavedLensRule);
  if (!allRulesReadable(rules)) return null;
  return {
    ...(typeof item.id === 'string' && item.id.length > 0 ? { id: item.id } : {}),
    name: item.name,
    rules,
    ...(item.autoColor ? { autoColor: { ...item.autoColor } } : {}),
  };
}

/**
 * Return an id derived from `base` that is not present in `taken`, and reserve
 * it (mutates `taken`). Guards against the rare case where time-based ids
 * (`lens-${Date.now()}`) collide — e.g. a rapid duplicate, or two id-less
 * imports in the same millisecond — which would make update/delete ambiguous. (#1403)
 */
export function reserveUniqueId(base: string, taken: Set<string>): string {
  let id = base;
  let n = 1;
  while (taken.has(id)) id = `${base}-${n++}`;
  taken.add(id);
  return id;
}

/**
 * Merge JSON-imported lenses into the existing set with **upsert-by-id**
 * semantics: a lens whose id already exists is replaced in place (its name,
 * rules, and autoColor are updated); a lens with a new or missing id is
 * appended as a fresh custom lens.
 *
 * This is what makes the export → edit-JSON → re-import round-trip actually
 * work. The previous importer skipped any id that already existed, so
 * re-importing an exported file (which always carries the existing ids,
 * including the built-ins) silently did nothing. (#1403)
 *
 * The `builtin` flag of an existing lens is preserved on replace, so a
 * re-imported built-in stays a built-in override rather than turning into a
 * duplicate custom lens. Order is preserved: replaced lenses keep their
 * position, new ones are appended.
 */
export function mergeImportedLenses(
  existing: readonly Lens[],
  imported: readonly unknown[],
  generateId: (index: number) => string,
): Lens[] {
  const byId = new Map<string, Lens>(existing.map((l) => [l.id, l]));
  const order: string[] = existing.map((l) => l.id);

  imported.forEach((item, i) => {
    const normalized = migrateSavedLens(item);
    if (!normalized) return;
    const id = normalized.id ?? generateId(i);
    const prior = byId.get(id);
    const merged: Lens = {
      id,
      name: normalized.name,
      rules: normalized.rules,
      builtin: prior?.builtin ?? false,
    };
    if (normalized.autoColor) {
      merged.autoColor = normalized.autoColor;
    }
    if (!byId.has(id)) order.push(id);
    byId.set(id, merged);
  });

  return order.map((id) => byId.get(id)!);
}

/**
 * Return a copy of `arr` with the item at `from` moved to `to`. Out-of-range
 * or no-op moves return a shallow copy unchanged. Used to reorder lens rules
 * via drag-and-drop — rule order is meaningful because the engine applies the
 * first matching rule per entity. (#1403)
 */
export function moveItem<T>(arr: readonly T[], from: number, to: number): T[] {
  const next = arr.slice();
  if (from < 0 || from >= next.length || to < 0 || to >= next.length || from === to) {
    return next;
  }
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}
