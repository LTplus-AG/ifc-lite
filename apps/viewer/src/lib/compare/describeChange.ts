/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * "What changed" detail for a single compare entry (issue #924).
 *
 * The diff engine classifies (added / modified / deleted) and says *which
 * signals* changed (`changeKinds`), but not *what*. This computes the
 * human-readable per-field delta lazily on selection — it re-extracts both
 * revisions of the entity from their `IfcDataStore`s and walks attributes +
 * property sets + resolved materials, plus a geometry summary (box-centre move
 * / bbox reshape, or a composed-placement move for a geometry-less product —
 * `geometrySummary.ts`). Kept out of the engine result so a 100k-entity diff
 * stays cheap; only the selected element is described.
 */

import type { DiffEntry } from '@ifc-lite/diff';
import { RelationshipType } from '@ifc-lite/data';
import {
  extractAllEntityAttributes,
  extractAllMaterialsOnDemand,
  extractPropertiesOnDemand,
  extractQuantitiesOnDemand,
  type IfcDataStore,
} from '@ifc-lite/parser';
import { lensMaterialNames } from '../lens-material-names.js';
import type { FederatedModel } from '../../store/types.js';
import type { CompareRef } from './buildFingerprints.js';
import { isGeometricDataName } from './geometricData.js';
import {
  meshBounds,
  placementMoveSummary,
  summarizeGeometryChange,
  type GeometrySummary,
} from './geometrySummary.js';

/** One changed/added/removed field between the A and B revisions. */
export interface FieldDelta {
  /** `attribute` = root attribute (Name/Description/…); `property` = Pset member;
   *  `quantity` = quantity-set member (Volume/Area/Length/…). */
  category: 'attribute' | 'property' | 'quantity';
  /** Property-/quantity-set name (undefined for root attributes). */
  group?: string;
  name: string;
  /** Display value in A (undefined = absent in A → added in B). */
  before?: string;
  /** Display value in B (undefined = absent in B → removed). */
  after?: string;
  kind: 'changed' | 'added' | 'removed';
}

export interface ChangeDetail {
  /** Non-geometric attribute/property changes (the "Data" story). */
  data: FieldDelta[];
  /** Geometry move/reshape summary, or null when geometry didn't change. */
  geometry: GeometrySummary | null;
  /** True when `data` is empty but the data hash still flagged a change —
   *  i.e. the only data difference was geometric (placement/quantity) and is
   *  intentionally not shown as data. */
  dataOnlyGeometric: boolean;
}

function displayValue(value: unknown): string {
  if (value == null) return '∅';
  if (typeof value === 'number') {
    // Trim float noise so "3.5000001" vs "3.5" doesn't read as different.
    return Number.isInteger(value) ? String(value) : value.toFixed(4).replace(/\.?0+$/, '');
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

/** The bare enum token IFC emits when a `PredefinedType` (or other enum) is set
 *  to a custom value. On its own it is meaningless; the real label lives in a
 *  companion attribute. */
const USER_DEFINED_TOKEN = 'USERDEFINED';

/**
 * Display a value, expanding the bare {@link USER_DEFINED_TOKEN} enum token with
 * its companion qualifier so Version Compare shows e.g. `USERDEFINED (origin)`
 * instead of a meaningless `USERDEFINED` (#1401). `companion` is the resolved
 * user-defined label for the *same* revision (ObjectType on occurrences,
 * ElementType on type objects); a missing or self-referential companion leaves
 * the token unqualified. The raw {@link displayValue} (and the equality check
 * that drives change detection in {@link sameValue}) is untouched; only the
 * presentation string gains the qualifier.
 */
function displayEnumValue(value: unknown, companion: string | undefined): string {
  const display = displayValue(value);
  if (display !== USER_DEFINED_TOKEN || !companion || companion === display) return display;
  return `${display} (${companion})`;
}

/** The user-defined qualifier for one revision: `ObjectType` on occurrences or
 *  `ElementType` on type objects. Both already sit in the extracted attribute
 *  map (via {@link extractAllEntityAttributes} / `getObjectType`), so a
 *  `PredefinedType` that reads `USERDEFINED` can borrow the real label from
 *  here (#1401). */
function userDefinedCompanion(data: ExtractedData): string | undefined {
  const raw = data.attributes.get('ObjectType') ?? data.attributes.get('ElementType');
  if (raw == null) return undefined;
  const label = displayValue(raw);
  return label && label !== '∅' ? label : undefined;
}

/** Are two extracted values equal for display purposes (stable, type-loose). */
function sameValue(a: unknown, b: unknown): boolean {
  return displayValue(a) === displayValue(b);
}

interface ExtractedField { group: string; name: string; value: unknown }

interface ExtractedData {
  attributes: Map<string, unknown>;
  /** `${psetName} ${propName}` → value */
  properties: Map<string, ExtractedField>;
  /** `${qtoName} ${qtyName}` -> value */
  quantities: Map<string, ExtractedField>;
}

function extractData(store: IfcDataStore, localId: number): ExtractedData {
  const attributes = new Map<string, unknown>();
  attributes.set('Name', store.entities.getName(localId) || undefined);
  attributes.set('Description', store.entities.getDescription(localId) || undefined);
  attributes.set('ObjectType', store.entities.getObjectType(localId) || undefined);
  for (const attr of extractAllEntityAttributes(store, localId)) {
    // Skip GlobalId (identity, never a "change") + any geometric/placement attr.
    if (attr.name === 'GlobalId') continue;
    if (isGeometricDataName(attr.name)) continue;
    if (attr.value == null || attr.value === '') continue;
    attributes.set(attr.name, attr.value);
  }

  const properties = new Map<string, ExtractedField>();
  for (const set of extractPropertiesOnDemand(store, localId)) {
    for (const prop of set.properties) {
      if (isGeometricDataName(prop.name) || isGeometricDataName(set.name)) continue;
      properties.set(`${set.name} ${prop.name}`, {
        group: set.name,
        name: prop.name,
        value: prop.value,
      });
    }
  }

  // Quantities mirror the data fingerprint (buildFingerprints.ts) so an added /
  // removed / edited quantity surfaces here as a concrete field delta (#1198).
  const quantities = new Map<string, ExtractedField>();
  for (const set of extractQuantitiesOnDemand(store, localId)) {
    if (isGeometricDataName(set.name)) continue;
    for (const qty of set.quantities) {
      if (isGeometricDataName(qty.name)) continue;
      quantities.set(`${set.name} ${qty.name}`, {
        group: set.name,
        name: qty.name,
        value: qty.value,
      });
    }
  }
  return { attributes, properties, quantities };
}

function diffData(a: ExtractedData, b: ExtractedData): FieldDelta[] {
  const out: FieldDelta[] = [];

  // Per-revision qualifier for any value that resolves to the bare USERDEFINED
  // enum token (#1401). Appended only to the display string, never the
  // comparison key (sameValue stays on the raw value).
  const aCompanion = userDefinedCompanion(a);
  const bCompanion = userDefinedCompanion(b);

  // Root attributes
  const attrNames = new Set([...a.attributes.keys(), ...b.attributes.keys()]);
  for (const name of attrNames) {
    const av = a.attributes.get(name);
    const bv = b.attributes.get(name);
    if (av == null && bv == null) continue;
    if (av != null && bv != null) {
      if (!sameValue(av, bv)) out.push({ category: 'attribute', name, before: displayEnumValue(av, aCompanion), after: displayEnumValue(bv, bCompanion), kind: 'changed' });
    } else if (bv != null) {
      out.push({ category: 'attribute', name, after: displayEnumValue(bv, bCompanion), kind: 'added' });
    } else {
      out.push({ category: 'attribute', name, before: displayEnumValue(av, aCompanion), kind: 'removed' });
    }
  }

  // Grouped property-set + quantity-set members (same added/removed/changed
  // logic; quantities are surfaced for #1198).
  diffFieldMap(a.properties, b.properties, 'property', out, aCompanion, bCompanion);
  diffFieldMap(a.quantities, b.quantities, 'quantity', out, aCompanion, bCompanion);

  // Attributes first, then properties, then quantities; alphabetical within.
  const rank: Record<FieldDelta['category'], number> = { attribute: 0, property: 1, quantity: 2 };
  return out.sort((x, y) =>
    rank[x.category] - rank[y.category] ||
    (x.group ?? '').localeCompare(y.group ?? '') ||
    x.name.localeCompare(y.name),
  );
}

/** Emit added/removed/changed deltas for one keyed field map (properties or
 *  quantities) into `out`. `aCompanion` / `bCompanion` qualify a bare
 *  USERDEFINED enum value (a custom property enum) with the element's
 *  user-defined label for display only (#1401); they never fire for quantities
 *  (numeric) and never change the comparison key. */
function diffFieldMap(
  a: Map<string, ExtractedField>,
  b: Map<string, ExtractedField>,
  category: 'property' | 'quantity',
  out: FieldDelta[],
  aCompanion?: string,
  bCompanion?: string,
): void {
  const keys = new Set([...a.keys(), ...b.keys()]);
  for (const key of keys) {
    const af = a.get(key);
    const bf = b.get(key);
    const group = (af ?? bf)!.group;
    const name = (af ?? bf)!.name;
    if (af && bf) {
      if (!sameValue(af.value, bf.value)) out.push({ category, group, name, before: displayEnumValue(af.value, aCompanion), after: displayEnumValue(bf.value, bCompanion), kind: 'changed' });
    } else if (bf) {
      out.push({ category, group, name, after: displayEnumValue(bf.value, bCompanion), kind: 'added' });
    } else if (af) {
      out.push({ category, group, name, before: displayEnumValue(af.value, aCompanion), kind: 'removed' });
    }
  }
}

/** The assigned type's stable label (DefinesByType), or '' when untyped.
 *  Mirrors the typeAssignments that go into the data fingerprint. */
function typeAssignmentLabel(store: IfcDataStore, localId: number): string {
  const ids = store.relationships.getRelated(localId, RelationshipType.DefinesByType, 'inverse');
  return ids
    .map((typeId) => store.entities.getName(typeId) || store.entities.getGlobalId(typeId) || '')
    .filter(Boolean)
    .sort()
    .join(', ');
}

/**
 * The element's resolved material names as one display label, or `''` when it
 * names none.
 *
 * Mirrors the `materials` slice of the data fingerprint
 * (`buildFingerprints.ts`) so the panel explains exactly the thing that moved
 * the hash. Sorted, because the fingerprint sorts: a label that reordered
 * between revisions would read as a change the diff did not make.
 */
function materialLabel(store: IfcDataStore, localId: number): string {
  return extractAllMaterialsOnDemand(store, localId)
    .flatMap(lensMaterialNames)
    .sort()
    .join(', ');
}

function geometrySummary(
  a: FederatedModel | undefined,
  aRef: CompareRef,
  b: FederatedModel | undefined,
  bRef: CompareRef,
): GeometrySummary | null {
  const ba = a?.geometryResult ? meshBounds(a.geometryResult.meshes, aRef.globalId) : null;
  const bb = b?.geometryResult ? meshBounds(b.geometryResult.meshes, bRef.globalId) : null;
  // No boxes to compare. For a pair that is geometry-less on BOTH sides (the
  // summary checks `ref.meshed` — missing boxes alone also describe a
  // GPU-instanced entity, which must stay on the box path), the geometry
  // signal came from the composed world placement (`buildFingerprints.ts`).
  // Describe THAT, rather than falling through to
  // `summarizeGeometryChange(null, null)` — which answers "reshaped", and a
  // product with no representation cannot reshape. That is the same false
  // "Reshaped" the field report flagged, arriving from the other direction.
  if (!ba && !bb) {
    const placement = placementMoveSummary(a, aRef, b, bRef);
    if (placement) return placement;
  }
  return summarizeGeometryChange(ba, bb);
}


/**
 * Describe what changed for one `modified` compare entry. Returns null for
 * non-modified entries (added/deleted/unchanged have no A↔B field delta).
 */
export function describeChange(
  entry: DiffEntry<CompareRef>,
  models: ReadonlyMap<string, FederatedModel>,
): ChangeDetail | null {
  if (entry.state !== 'modified' || !entry.base || !entry.head) return null;
  const aRef = entry.base.ref;
  const bRef = entry.head.ref;
  const aStore = models.get(aRef.modelId)?.ifcDataStore;
  const bStore = models.get(bRef.modelId)?.ifcDataStore;

  // Only describe data when the data signal is in scope — `changeKinds` is
  // already scope-filtered by the engine, so a Geometry-scope diff shows the
  // move only (no data), and vice versa. This keeps the detail panel as cleanly
  // separated as the list badges.
  const data: FieldDelta[] = [];
  if (entry.changeKinds.includes('data')) {
    // IFC type change (the engine counts a type flip as a data change).
    if (entry.base.ifcType !== entry.head.ifcType) {
      data.push({ category: 'attribute', name: 'Type', before: entry.base.ifcType, after: entry.head.ifcType, kind: 'changed' });
    }
    if (aStore && bStore) {
      data.push(...diffData(extractData(aStore, aRef.localId), extractData(bStore, bRef.localId)));
      // Type assignment (DefinesByType) — in the data fingerprint, so surface it.
      const aType = typeAssignmentLabel(aStore, aRef.localId);
      const bType = typeAssignmentLabel(bStore, bRef.localId);
      if (aType !== bType && (aType || bType)) {
        data.push({
          category: 'attribute',
          name: 'Type assignment',
          before: aType || undefined,
          after: bType || undefined,
          kind: aType && bType ? 'changed' : bType ? 'added' : 'removed',
        });
      }
      // Material, on the same rule and for the same reason: it is in the data
      // fingerprint, so it has to be explainable. Compared as resolved NAMES,
      // so a re-save that only renumbered the `IfcMaterial` produces no row.
      const aMaterial = materialLabel(aStore, aRef.localId);
      const bMaterial = materialLabel(bStore, bRef.localId);
      if (aMaterial !== bMaterial) {
        data.push({
          category: 'attribute',
          name: 'Material',
          before: aMaterial || undefined,
          after: bMaterial || undefined,
          kind: aMaterial && bMaterial ? 'changed' : bMaterial ? 'added' : 'removed',
        });
      }
    }
  }

  const geometry = entry.changeKinds.includes('geometry')
    ? geometrySummary(models.get(aRef.modelId), aRef, models.get(bRef.modelId), bRef)
    : null;

  const dataOnlyGeometric = entry.changeKinds.includes('data') && data.length === 0;

  return { data, geometry, dataOnlyGeometric };
}
