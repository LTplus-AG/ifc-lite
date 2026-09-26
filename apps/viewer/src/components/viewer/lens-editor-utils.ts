/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Lens, LensRule, LensCriteria, AutoColorSpec } from '@/store/slices/lensSlice';
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
    criteria: cloneCriteria(r.criteria),
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

/**
 * Check if a rule has sufficient criteria to be valid / saveable.
 *
 * A compound (`and` / `or`) with at least one member is valid even though
 * the panel cannot author its members - the prior `default: return false`
 * branch silently dropped every compound rule from `rules` on Save (the
 * `LensEditor`'s `handleSave` filters through this predicate), destroying an
 * imported compound rule the moment its lens was opened and re-saved. An
 * empty/missing `conditions` array is treated as invalid, matching the
 * engine's own fail-closed semantics for an empty group.
 *
 * A compound's members are validated recursively rather than just checked
 * for a non-empty array: an `and` wrapping an incomplete leaf (e.g.
 * `{ type: 'ifcType' }`, missing `ifcType`) can never match - `and` requires
 * EVERY member to match - so it must be dropped exactly like the bare
 * incomplete leaf would be, or Save silently persists a permanently-inert
 * rule. An `or` only needs ONE valid member, mirroring the engine's own
 * `matchesCompound`, where the other members of an `or` can still match even
 * if one is absent/malformed. A non-object member (see {@link cloneCriteria}
 * for why this is reachable via hand-edited import JSON) is invalid.
 */
export function isRuleValid(rule: LensRule): boolean {
  if (rule.unreadableLegacy) return true;
  if (rule.groups) return rule.groups.some((group) => group.rules.length > 0);
  return isCriteriaValid(rule.criteria, 0);
}

function isCriteriaValid(c: LensCriteria, depth: number): boolean {
  switch (c.type) {
    case 'ifcType': return !!c.ifcType;
    case 'attribute': return !!c.attributeName;
    case 'property': return !!c.propertySet && !!c.propertyName;
    case 'quantity': return !!c.quantitySet && !!c.quantityName;
    case 'classification': return !!c.classificationSystem || !!c.classificationCode;
    case 'material': return !!c.materialName;
    case 'model': return !!c.modelId;
    // A blank group name is valid - it matches any entity assigned to a zone.
    case 'group': return true;
    case 'and': {
      if (depth >= MAX_COMPOUND_DEPTH) return false;
      const conditions = c.conditions;
      if (!Array.isArray(conditions) || conditions.length === 0) return false;
      return conditions.every((m) => isCriteriaLike(m) && isCriteriaValid(m, depth + 1));
    }
    case 'or': {
      if (depth >= MAX_COMPOUND_DEPTH) return false;
      const conditions = c.conditions;
      if (!Array.isArray(conditions) || conditions.length === 0) return false;
      return conditions.some((m) => isCriteriaLike(m) && isCriteriaValid(m, depth + 1));
    }
    default: return false;
  }
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
