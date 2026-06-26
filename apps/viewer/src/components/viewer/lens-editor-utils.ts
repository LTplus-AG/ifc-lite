/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Lens, LensRule, AutoColorSpec } from '@/store/slices/lensSlice';

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

/**
 * Build an editable copy of a lens.
 *
 * The copy gets a fresh id, a "(copy)" suffix, and (crucially) drops the
 * `builtin` flag so it can be edited and deleted — duplicating a built-in
 * preset is how the user gets an editable starting point (e.g. add CLADDING
 * to a copy of "Building Envelope"). Rule ids are regenerated and the
 * criteria object is cloned so editing the copy never mutates the source. (#1403)
 */
export function duplicateLensConfig(lens: Lens, generateId: () => string): Lens {
  const newId = generateId();
  const copy: Lens = {
    id: newId,
    name: `${lens.name} (copy)`,
    rules: lens.rules.map((r, i) => ({
      ...r,
      id: `${newId}-rule-${i}`,
      criteria: { ...r.criteria },
    })),
  };
  if (lens.autoColor) copy.autoColor = { ...lens.autoColor };
  return copy;
}

/** A single lens shape accepted by the JSON importer. */
function isImportableLens(item: unknown): item is { id?: unknown; name: string; rules: LensRule[]; autoColor?: unknown } {
  if (item === null || typeof item !== 'object') return false;
  const obj = item as Record<string, unknown>;
  return typeof obj.name === 'string' && obj.name.length > 0 && Array.isArray(obj.rules);
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
    if (!isImportableLens(item)) return;
    const id = typeof item.id === 'string' && item.id.length > 0 ? item.id : generateId(i);
    const prior = byId.get(id);
    const merged: Lens = {
      id,
      name: item.name,
      rules: item.rules,
      builtin: prior?.builtin ?? false,
    };
    if (item.autoColor && typeof item.autoColor === 'object') {
      merged.autoColor = item.autoColor as AutoColorSpec;
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
