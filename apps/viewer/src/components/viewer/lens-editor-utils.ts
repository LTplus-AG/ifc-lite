/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Lens, LensRule, LensCriteria, AutoColorSpec } from '@/store/slices/lensSlice';
import type { FilterRule } from '@ifc-lite/rules';
// Import the value directly from the source package (not via the slice) to avoid
// a circular value import: lensSlice imports the helpers from this module.
import { MAX_COMPOUND_DEPTH } from '@ifc-lite/lens';

function isCriteriaLike(value: unknown): value is LensCriteria {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

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
 * Deep-clone a lens rule's criteria, recursively.
 *
 * A compound criteria (`type: 'and' | 'or'`) nests further criteria in its
 * `conditions` array - which may itself contain further compounds. A
 * shallow `{ ...criteria }` copy still aliases that array (and any nested
 * compound's own array) with the source object. Any later mutation reached
 * through the copy - e.g. editing a duplicated lens, or a future
 * compound-authoring UI - would then silently corrupt the original through
 * the shared reference. Leaf criteria have no nested structure, so a
 * shallow copy is sufficient for them.
 *
 * `depth` caps the recursion at {@link MAX_COMPOUND_DEPTH}, matching the
 * engine's own compound-depth cap: a pathological hand-edited lens file
 * (thousands of nested `and`/`or` levels) parses and imports fine, and the
 * engine correctly treats it as inert past the cap - but without this guard,
 * clicking Edit or Duplicate on that lens would recurse unboundedly and throw
 * `RangeError: Maximum call stack size exceeded` inside a React event
 * handler. Beyond the cap the conditions array is copied one level shallow
 * (not recursed into) rather than cloned further - acceptable because the
 * engine already treats everything past the cap as unreachable/inert. A
 * non-object member (`null`, a string, a number - possible via hand-edited
 * JSON, since the import validator does not recurse into `conditions`) is
 * left as-is rather than recursed into, matching the engine's own
 * malformed-member guard (`isCriteriaRecord` in matching.ts) instead of
 * throwing `TypeError: Cannot read properties of null`.
 */
export function cloneCriteria(criteria: LensCriteria, depth = 0): LensCriteria {
  if (
    (criteria.type === 'and' || criteria.type === 'or')
    && Array.isArray(criteria.conditions)
    && depth < MAX_COMPOUND_DEPTH
  ) {
    return {
      ...criteria,
      conditions: criteria.conditions.map((c) => (isCriteriaLike(c) ? cloneCriteria(c, depth + 1) : c)),
    };
  }
  return { ...criteria };
}

/**
 * Deep-clone every rule's criteria in a rule list via {@link cloneCriteria},
 * preserving every other rule field. This is the one place that pattern is
 * written - `rules.map(r => ({ ...r, criteria: cloneCriteria(r.criteria) }))`
 * was duplicated at four call sites (the `LensEditor` state initializer,
 * `handleEditLens`, `handleDuplicateLens`, and here in
 * {@link duplicateLensConfig}) before being lifted out; a future fifth call
 * site that hand-rolls the same shallow spread instead of calling this would
 * silently reopen the aliasing bug this whole file exists to close.
 */
export function cloneLensRules(rules: readonly LensRule[]): LensRule[] {
  return rules.map((r) => ({
    ...r,
    ...(r.criteria ? { criteria: cloneCriteria(r.criteria) } : {}),
    ...(r.groups ? { groups: structuredClone(r.groups) } : {}),
    ...(r.unreadableLegacy ? { unreadableLegacy: structuredClone(r.unreadableLegacy) } : {}),
  }));
}

/**
 * Build an editable copy of a lens.
 *
 * The copy gets a fresh id, a "(copy)" suffix, and (crucially) drops the
 * `builtin` flag so it can be edited and deleted - duplicating a built-in
 * preset is how the user gets an editable starting point (e.g. add CLADDING
 * to a copy of "Building Envelope"). Rule ids are regenerated and the
 * criteria object is deep-cloned (see {@link cloneCriteria}) so editing the
 * copy - including a compound criteria's nested conditions - never mutates
 * the source. (#1403)
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

/** Empty chip presets must not turn a saved Lens into an inert filter. */
function isConfiguredFilterRule(rule: FilterRule): boolean {
  if (!rule || typeof rule !== 'object') return false;
  switch (rule.kind) {
    case 'model':
    case 'ifcType':
    case 'predefinedType':
    case 'globalId': return Array.isArray(rule.values) && rule.values.length > 0;
    case 'storey': return (Array.isArray(rule.values) && rule.values.length > 0)
      || (Array.isArray(rule.refs) && rule.refs.length > 0);
    case 'modelTag': return rule.op === 'untagged'
      || (Array.isArray(rule.tagIds) && rule.tagIds.length > 0);
    case 'attribute': return typeof rule.name === 'string' && rule.name.trim().length > 0;
    case 'property': return typeof rule.propertyName === 'string' && rule.propertyName.trim().length > 0;
    case 'quantity': return typeof rule.quantityName === 'string' && rule.quantityName.trim().length > 0;
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
