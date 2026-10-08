/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Lens, LensRule, AutoColorSpec } from '@/store/slices/lensSlice';
import { isFilterRule, type FilterRule } from '@ifc-lite/rules';
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

/** Copy shared groups and unreadable saved data without aliasing the source. */
export function cloneLensRules(rules: readonly LensRule[]): LensRule[] {
  return rules.map((r) => ({
    ...r,
    ...(r.groups ? { groups: structuredClone(r.groups) } : {}),
    ...(r.unreadableLegacy ? { unreadableLegacy: structuredClone(r.unreadableLegacy) } : {}),
  }));
}

/**
 * Build an editable copy of a lens.
 *
 * The copy gets a fresh id and a "(copy)" suffix, drops the builtin flag,
 * and deep-clones group filters so edits cannot mutate the source (#1403).
 */
export function duplicateLensConfig(lens: Lens, generateId: () => string): Lens {
  const newId = generateId();
  const copy: Lens = {
    id: newId,
    name: `${lens.name} (copy)`,
    rules: cloneLensRules(lens.rules).map((r, i) => ({ ...r, id: `${newId}-rule-${i}` })),
  };
  if (lens.autoColor) copy.autoColor = { ...lens.autoColor };
  if (lens.capturedScope) copy.capturedScope = structuredClone(lens.capturedScope);
  return copy;
}

/** Empty chip presets must not turn a saved Lens into an inert filter. */
function isConfiguredFilterRule(rule: FilterRule): boolean {
  if (!isFilterRule(rule)) return false;
  switch (rule.kind) {
    case 'model':
    case 'ifcType':
    case 'predefinedType':
    case 'globalId': return Array.isArray(rule.values) && rule.values.length > 0;
    case 'storey': return (Array.isArray(rule.values) && rule.values.length > 0)
      || (Array.isArray(rule.refs) && rule.refs.length > 0);
    case 'modelTag': return rule.op === 'untagged'
      || (Array.isArray(rule.tagIds) && rule.tagIds.length > 0);
    case 'name':
    case 'material':
    case 'type':
    case 'parent': return typeof rule.value === 'string' && rule.value.trim().length > 0;
    case 'classification':
    case 'group': return typeof rule.value === 'string' &&
      (rule.op === 'isSet' || rule.op === 'isNotSet' || rule.value.trim().length > 0);
    case 'elevation': return typeof rule.value === 'number' && Number.isFinite(rule.value);
    case 'attribute': return typeof rule.name === 'string' && rule.name.trim().length > 0;
    case 'property': return typeof rule.propertyName === 'string' && rule.propertyName.trim().length > 0;
    case 'quantity': return typeof rule.quantityName === 'string' && rule.quantityName.trim().length > 0
      && typeof rule.value === 'number' && Number.isFinite(rule.value);
    case 'modelFact': return true;
    default: return false;
  }
}

/** Save configured shared filters or preserved unreadable source data. */
export function isRuleValid(rule: LensRule): boolean {
  if (rule.unreadableLegacy) return true;
  return Array.isArray(rule.groups) && rule.groups.length > 0 &&
    rule.groups.every((group) => Array.isArray(group?.rules) && group.rules.length > 0 &&
      group.rules.every(isConfiguredFilterRule));
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
