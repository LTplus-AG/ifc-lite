/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { AutoColorSpec, ClassificationInfo, LensDataProvider } from './types.js';

/**
 * A grouping key plus the human-readable label shown in the legend. They are
 * identical for every source except `classification`, where grouping stays by
 * `System: Code` (stable identity) but the label also surfaces the name, so the
 * same code never fragments across slightly different names. (#1460)
 */
interface AutoColorValue {
  key: string;
  label: string;
}

/**
 * Pick the classification reference to group by - the one whose system matches
 * `psetName` (case-insensitive substring) when set, else the first.
 *
 * When `psetName` is set it acts as a classification-system FILTER: an entity
 * that carries classifications but none from the selected system must not be
 * grouped under some other, unrelated system. Returns `undefined` in that
 * case so the caller ghosts the entity instead of silently falling back to
 * `cls[0]` (#1923 — the "System" picker on the classification auto-color lens
 * was a no-op because every entity fell back to its first classification
 * regardless of which system was selected).
 */
function selectClassificationRef(
  cls: ReadonlyArray<ClassificationInfo>,
  psetName?: string,
): ClassificationInfo | undefined {
  if (!psetName) return cls[0];
  return cls.find((ref) => (ref.system ?? '').toLowerCase().includes(psetName.toLowerCase()));
}

/**
 * Why a `source: "classification"` entity produced zero grouping values —
 * used only when {@link AutoColorSpec.includeUnclassified} is on, to route
 * the entity into the right absence bucket instead of ghosting it. Only
 * called once {@link extractAutoColorValues} has already returned `[]` for
 * this entity/spec pair.
 *
 * - `'no-classification'`: zero classification references at all, OR (with
 *   no `psetName` filter) any value-less reason — there is no specific
 *   system to be "not in", so everything collapses to one bucket.
 * - `'not-in-system'`: the entity carries references, `psetName` names a
 *   system, and none of the references matched it
 *   ({@link selectClassificationRef} returned `undefined`).
 *
 * One degenerate case folds into `'no-classification'` even though a
 * reference *did* match the selected system: a classification record with an
 * empty system, identification, AND name (garbage/placeholder data). It
 * carries no usable value, so — like having no classification at all — there
 * is nothing to color it by; calling it "not in this system" would be wrong,
 * since it IS in the system, just empty.
 */
export function classificationAbsenceReason(
  spec: AutoColorSpec,
  globalId: number,
  provider: LensDataProvider,
): 'no-classification' | 'not-in-system' {
  const cls = provider.getClassifications?.(globalId);
  if (!cls || cls.length === 0) return 'no-classification';
  if (!spec.psetName) return 'no-classification';
  const matched = selectClassificationRef(cls, spec.psetName);
  return matched ? 'no-classification' : 'not-in-system';
}

/**
 * Extract every distinct value an entity should be grouped under. Only
 * `material` is multi-valued — an element with a layer / constituent set
 * belongs to each of its individual materials; all other sources collapse to
 * a single value. Values are trimmed and de-duplicated; empties are dropped.
 * Falls back to the single-valued {@link extractAutoColorValue} when the
 * multi-material accessor is unavailable. (#1366)
 */
export function extractAutoColorValues(
  spec: AutoColorSpec,
  globalId: number,
  provider: LensDataProvider,
): AutoColorValue[] {
  // Classification: group by "System: Code", but label with the name too so the
  // legend reads e.g. "Uniclass: EF_25_10 (Walls)". (#1460)
  if (spec.source === 'classification' && provider.getClassifications) {
    const cls = provider.getClassifications(globalId);
    if (!cls || cls.length === 0) return [];
    const c = selectClassificationRef(cls, spec.psetName);
    if (!c) return [];
    const codeParts: string[] = [];
    if (c.system) codeParts.push(c.system);
    if (c.identification) codeParts.push(c.identification);
    const code = codeParts.join(': ');
    const name = c.name?.trim();
    const key = code || name || '';
    if (key === '') return [];
    // Append the name only when it adds information beyond the code: skip it when
    // it merely repeats the bare identification OR the full "System: Code" string
    // (some exports store the whole code in the name attribute).
    const nameAddsInfo = !!name && name !== c.identification && name !== code;
    const label = code && nameAddsInfo ? `${code} (${name})` : key;
    return [{ key, label }];
  }

  if (spec.source === 'material' && provider.getMaterialNames) {
    const names = provider.getMaterialNames(globalId);
    if (names && names.length > 0) {
      const seen = new Set<string>();
      for (const n of names) {
        const t = (n ?? '').trim();
        if (t) seen.add(t);
      }
      if (seen.size > 0) return [...seen].map((k) => ({ key: k, label: k }));
    }
    // else fall through to the single-valued accessor
  }

  const raw = extractAutoColorValue(spec, globalId, provider);
  const value = raw != null ? String(raw).trim() : '';
  return value === '' ? [] : [{ key: value, label: value }];
}

/**
 * Extract the target value for a single entity based on the auto-color spec.
 * Returns the raw value (string, number, etc.) or undefined if not available.
 */
function extractAutoColorValue(
  spec: AutoColorSpec,
  globalId: number,
  provider: LensDataProvider,
): string | number | undefined {
  switch (spec.source) {
    case 'ifcType':
      return provider.getEntityType(globalId);

    case 'attribute':
      if (!spec.propertyName || !provider.getEntityAttribute) return undefined;
      return provider.getEntityAttribute(globalId, spec.propertyName);

    case 'property':
      if (!spec.psetName || !spec.propertyName) return undefined;
      {
        const val = provider.getPropertyValue(globalId, spec.psetName, spec.propertyName);
        return val != null ? String(val) : undefined;
      }

    case 'quantity':
      if (!spec.psetName || !spec.propertyName || !provider.getQuantityValue) return undefined;
      return provider.getQuantityValue(globalId, spec.psetName, spec.propertyName);

    case 'classification':
      if (!provider.getClassifications) return undefined;
      {
        const cls = provider.getClassifications(globalId);
        if (!cls || cls.length === 0) return undefined;
        // Use "system: identification" as the grouping key. When psetName is set,
        // treat it as a classification-system filter (mirroring matchesClassification),
        // selecting the matching reference instead of unconditionally using the first.
        const c = selectClassificationRef(cls, spec.psetName);
        if (!c) return undefined;
        const parts: string[] = [];
        if (c.system) parts.push(c.system);
        if (c.identification) parts.push(c.identification);
        return parts.length > 0 ? parts.join(': ') : c.name;
      }

    case 'material':
      if (!provider.getMaterialName) return undefined;
      return provider.getMaterialName(globalId);

    case 'model':
      if (!provider.getModelId) return undefined;
      return provider.getModelId(globalId);

    case 'group': {
      if (!provider.getEntityGroups) return undefined;
      const groups = provider.getEntityGroups(globalId);
      if (!groups || groups.length === 0) return undefined;
      // Prefer an IfcZone membership so multi-group entities (IfcZone +
      // IfcGroup/IfcSystem) bucket by zone deterministically, not by whichever
      // relation happened to come first. Use the name when present, then the
      // ObjectType (e.g. a system designation), else "Type #id" so unnamed
      // groups still bucket distinctly. (#1075)
      const g = groups.find((x) => x.type === 'IfcZone') ?? groups[0];
      if (g.name && g.name.trim() !== '') return g.name;
      if (g.objectType && g.objectType.trim() !== '') return `${g.type}: ${g.objectType}`;
      return `${g.type} #${g.id}`;
    }

    default:
      return undefined;
  }
}
