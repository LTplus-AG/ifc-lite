/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Lens, LensRule, LensCriteria, AutoColorSpec } from '@/store/slices/lensSlice';
// Import the value directly from the source package (not via the slice) to avoid
// a circular value import: lensSlice imports the helpers from this module.
import { AUTO_COLOR_SOURCES } from '@ifc-lite/lens';

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
 * `conditions` array — which may itself contain further compounds. A
 * shallow `{ ...criteria }` copy still aliases that array (and any nested
 * compound's own array) with the source object. Any later mutation reached
 * through the copy — e.g. editing a duplicated lens, or a future
 * compound-authoring UI — would then silently corrupt the original through
 * the shared reference. Leaf criteria have no nested structure, so a
 * shallow copy is sufficient for them.
 */
export function cloneCriteria(criteria: LensCriteria): LensCriteria {
  if ((criteria.type === 'and' || criteria.type === 'or') && Array.isArray(criteria.conditions)) {
    return { ...criteria, conditions: criteria.conditions.map(cloneCriteria) };
  }
  return { ...criteria };
}

/**
 * Build an editable copy of a lens.
 *
 * The copy gets a fresh id, a "(copy)" suffix, and (crucially) drops the
 * `builtin` flag so it can be edited and deleted — duplicating a built-in
 * preset is how the user gets an editable starting point (e.g. add CLADDING
 * to a copy of "Building Envelope"). Rule ids are regenerated and the
 * criteria object is deep-cloned (see {@link cloneCriteria}) so editing the
 * copy — including a compound criteria's nested conditions — never mutates
 * the source. (#1403)
 */
export function duplicateLensConfig(lens: Lens, generateId: () => string): Lens {
  const newId = generateId();
  const copy: Lens = {
    id: newId,
    name: `${lens.name} (copy)`,
    rules: lens.rules.map((r, i) => ({
      ...r,
      id: `${newId}-rule-${i}`,
      criteria: cloneCriteria(r.criteria),
    })),
  };
  if (lens.autoColor) copy.autoColor = { ...lens.autoColor };
  return copy;
}

/** True when a criteria is a compound (`and` / `or`) rather than a leaf. */
export function isCompoundCriteria(criteria: LensCriteria): boolean {
  return criteria.type === 'and' || criteria.type === 'or';
}

/**
 * Human-readable label for a single criterion. Leaf types each derive a
 * short name from their most identifying field (mirrors the panel's prior
 * inline `deriveRuleName`). A compound recurses into its member conditions
 * and joins their names — e.g. `AND (IfcWall, FireRating)` — so an imported
 * compound rule gets an honest name instead of falling through to a generic
 * default. Used both as a rule's display name and inside a compound's
 * read-only summary tooltip (see {@link compoundCriteriaSummary}).
 */
export function deriveRuleName(
  criteria: LensCriteria,
  resolveModelName?: (modelId: string) => string | undefined,
): string {
  switch (criteria.type) {
    case 'ifcType': return criteria.ifcType ? criteria.ifcType.replace('Ifc', '') : 'New Rule';
    case 'attribute': return criteria.attributeValue || criteria.attributeName || 'Attribute';
    case 'property': return criteria.propertyName || 'Property';
    case 'quantity': return criteria.quantityName || 'Quantity';
    case 'classification': return criteria.classificationCode || criteria.classificationSystem || 'Classification';
    case 'material': return criteria.materialName || 'Material';
    case 'model': {
      const name = criteria.modelId ? resolveModelName?.(criteria.modelId) : undefined;
      return name || 'Model';
    }
    case 'group': return criteria.groupName || 'Zone';
    case 'and':
    case 'or': {
      const parts = (criteria.conditions ?? []).map((c) => deriveRuleName(c, resolveModelName));
      return parts.length > 0
        ? `${criteria.type.toUpperCase()} (${parts.join(', ')})`
        : `${criteria.type.toUpperCase()} (empty)`;
    }
    default: return 'Rule';
  }
}

/**
 * Read-only summary for a compound criterion: a short `label` ("AND — 2
 * conditions") for the row itself, and an expanded `detail` string listing
 * each member's name, for use as a tooltip.
 *
 * The panel deliberately does not offer authoring compound criteria yet —
 * the rule editor's per-type controls only produce leaves. But the import
 * path accepts a compound `criteria.type` (validated only structurally), so
 * an imported compound rule must still be displayed honestly rather than
 * degenerately falling through the leaf editor's type-specific branches
 * (which all guard on `criteriaType === '<leaf>'` and so render nothing for
 * `'and'` / `'or'`).
 */
export function compoundCriteriaSummary(
  criteria: LensCriteria,
  resolveModelName?: (modelId: string) => string | undefined,
): { label: string; detail: string } {
  const conditions = criteria.conditions ?? [];
  const count = conditions.length;
  const kind = criteria.type.toUpperCase();
  return {
    label: `${kind} — ${count} condition${count === 1 ? '' : 's'}`,
    detail: count > 0 ? conditions.map((c) => deriveRuleName(c, resolveModelName)).join(', ') : 'No conditions',
  };
}

/**
 * Check if a rule has sufficient criteria to be valid / saveable.
 *
 * A compound (`and` / `or`) with at least one member is valid even though
 * the panel cannot author its members — the prior `default: return false`
 * branch silently dropped every compound rule from `rules` on Save (the
 * `LensEditor`'s `handleSave` filters through this predicate), destroying an
 * imported compound rule the moment its lens was opened and re-saved. An
 * empty/missing `conditions` array is treated as invalid, matching the
 * engine's own fail-closed semantics for an empty group.
 */
export function isRuleValid(rule: LensRule): boolean {
  const c = rule.criteria;
  switch (c.type) {
    case 'ifcType': return !!c.ifcType;
    case 'attribute': return !!c.attributeName;
    case 'property': return !!c.propertySet && !!c.propertyName;
    case 'quantity': return !!c.quantitySet && !!c.quantityName;
    case 'classification': return !!c.classificationSystem || !!c.classificationCode;
    case 'material': return !!c.materialName;
    case 'model': return !!c.modelId;
    // A blank group name is valid — it matches any entity assigned to a zone.
    case 'group': return true;
    case 'and':
    case 'or':
      return Array.isArray(c.conditions) && c.conditions.length > 0;
    default: return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Validate a single rule from imported JSON before it enters the store. A
 *  malformed rule (e.g. `null`, or missing criteria) would otherwise break
 *  rule rendering and matching. */
function isImportableRule(item: unknown): item is LensRule {
  if (!isRecord(item)) return false;
  return typeof item.id === 'string'
    && typeof item.name === 'string'
    && typeof item.enabled === 'boolean'
    && isRecord(item.criteria)
    && typeof item.criteria.type === 'string'
    && typeof item.action === 'string'
    && typeof item.color === 'string';
}

/** Validate an auto-color spec from imported JSON (source must be a known
 *  source; the optional name fields must be strings if present). */
function isImportableAutoColor(item: unknown): item is AutoColorSpec {
  if (!isRecord(item)) return false;
  if (typeof item.source !== 'string'
    || !(AUTO_COLOR_SOURCES as readonly string[]).includes(item.source)) return false;
  if (item.psetName !== undefined && typeof item.psetName !== 'string') return false;
  if (item.propertyName !== undefined && typeof item.propertyName !== 'string') return false;
  return true;
}

/** A single lens shape accepted by the JSON importer. Rules and the optional
 *  auto-color spec are fully shape-checked so a hand-edited/corrupt file cannot
 *  push malformed entries (`rules: [null]`, `autoColor: []`) into the store. */
function isImportableLens(item: unknown): item is { id?: unknown; name: string; rules: LensRule[]; autoColor?: AutoColorSpec } {
  if (!isRecord(item)) return false;
  return typeof item.name === 'string'
    && item.name.length > 0
    && Array.isArray(item.rules)
    && item.rules.every(isImportableRule)
    && (item.autoColor === undefined || isImportableAutoColor(item.autoColor));
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
    if (!isImportableLens(item)) return;
    const id = typeof item.id === 'string' && item.id.length > 0 ? item.id : generateId(i);
    const prior = byId.get(id);
    const merged: Lens = {
      id,
      name: item.name,
      rules: item.rules,
      builtin: prior?.builtin ?? false,
    };
    if (item.autoColor) {
      merged.autoColor = { ...item.autoColor };
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
