/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The store adapter for `checkStructuralConsistency`. Reads the parsed file;
 * edits held in a mutation view are not applied. To check an edited model,
 * export it and parse the result.
 */

import { exactTypeName } from '@ifc-lite/data';
import type { IfcDataStore } from './columnar-parser.js';
import { extractTypePropertiesOnDemand } from './on-demand-extractors.js';
import { mergeInheritedPropertySets } from './property-set-merge.js';
import { expandTypes } from './query-backend-maps.js';
import {
  checkStructuralConsistency,
  hasAnalyticalModel,
  isA,
  LOAD_BEARING_CLASSES,
  type PhysicalElementFact,
  type StructuralDerivationRecord,
  type StructuralGeometryFacts,
  type StructuralConsistencyIssue,
  type StructuralConsistencyOptions,
  type StructuralLine,
} from './structural-consistency.js';
import { ItemGeometryReader } from './structural-item-geometry.js';
import { structuralCounterparts } from './structural-counterparts.js';
import { extractStructuralOnDemand } from './structural-extractor.js';
import type { StructuralExtraction } from './structural-types.js';

/** The property set derive writes on each curve member it creates, and its properties. */
export const STRUCTURAL_DERIVATION_PSET = 'IfcLite_StructuralDerivation';
export const DERIVATION_ELEMENT_PROPERTY = 'PhysicalElement';
/** The element's line in IFC world metres: start x, y, z, then end x, y, z. */
export const DERIVATION_AXIS_PROPERTIES = [
  'PhysicalAxisStartX', 'PhysicalAxisStartY', 'PhysicalAxisStartZ',
  'PhysicalAxisEndX', 'PhysicalAxisEndY', 'PhysicalAxisEndZ',
] as const;

type NamedPset = { name: string; properties: ReadonlyArray<{ name: string; value: unknown }> };

/**
 * `LoadBearing` from any `Pset_*Common`. The occurrence's sets come first in
 * the merge, so the first value found wins over the type's; a non-boolean
 * winner (IfcLogical UNKNOWN) counts as unstated.
 */
function loadBearing(store: IfcDataStore, expressId: number): boolean | undefined {
  const psets = mergeInheritedPropertySets<NamedPset>(store.getProperties(expressId), extractTypePropertiesOnDemand(store, expressId)?.properties ?? []);
  for (const pset of psets) {
    const name = pset.name.toLowerCase();
    if (!name.startsWith('pset_') || !name.endsWith('common')) continue;
    const property = pset.properties.find((candidate) => candidate.name === 'LoadBearing');
    if (property) return typeof property.value === 'boolean' ? property.value : undefined;
  }
  return undefined;
}

/**
 * Every element of a load-bearing class, subtypes included, per the file's
 * schema. These classes cover every class the mismatch rule names too.
 * LoadBearing is read only for elements with no structural item: no rule
 * reads it for the others.
 */
export function structuralConsistencyFacts(store: IfcDataStore, structural: StructuralExtraction): PhysicalElementFact[] {
  const ids = new Set<number>();
  for (const type of expandTypes(LOAD_BEARING_CLASSES.map((name) => name.toUpperCase()), store.schemaVersion)) {
    // @raw-entity-enumeration-ok the checks read the parsed file, as `ifc-lite validate` does
    for (const id of store.entityIndex.byType.get(type) ?? []) ids.add(id);
  }

  const facts: PhysicalElementFact[] = [];
  for (const expressId of [...ids].sort((a, b) => a - b)) {
    const stated = structuralCounterparts(structural, expressId) ? undefined : loadBearing(store, expressId);
    facts.push({
      expressId,
      globalId: store.entities.getGlobalId(expressId),
      type: exactTypeName(store.entities, expressId),
      ...(stated === undefined ? {} : { loadBearing: stated }),
    });
  }
  return facts;
}

export interface StructuralConsistencyIssuesOptions extends StructuralConsistencyOptions {
  /**
   * Each physical element's analytical line by express id, in IFC world
   * metres: `structuralPhysicalAxes` in `@ifc-lite/create` reads them by the
   * derivation's rules. The axis-drift rule runs only when this is given.
   */
  physicalAxes?: ReadonlyMap<number, StructuralLine>;
}

/**
 * The curve members assigned to an element in `physicalAxes`, the only ones
 * the geometry rules compare: each one's edge in IFC world metres, and the
 * derivation record of those that carry one.
 */
function curveMemberGeometry(store: IfcDataStore, structural: StructuralExtraction, physicalAxes: ReadonlyMap<number, StructuralLine>): StructuralGeometryFacts {
  const reader = new ItemGeometryReader(store);
  const memberLines = new Map<number, StructuralLine>();
  const derivationRecords = new Map<number, StructuralDerivationRecord>();
  for (const member of structural.members) {
    if (!isA(member.type, ['IfcStructuralCurveMember']) || !structuralCounterparts(structural, member.expressId)?.expressIds.some((id) => physicalAxes.has(id))) continue;
    const shape = reader.shape(member.expressId);
    if (shape?.kind === 'edge') memberLines.set(member.expressId, [shape.start, shape.end]);
    const record = derivationRecord(store, member.expressId);
    if (record) derivationRecords.set(member.expressId, record);
  }
  return { physicalAxes, memberLines, derivationRecords };
}

/** The member's derivation record, when it is complete: a GlobalId and six finite coordinates. */
function derivationRecord(store: IfcDataStore, memberId: number): StructuralDerivationRecord | null {
  const set = store.getProperties(memberId).find((pset) => pset.name === STRUCTURAL_DERIVATION_PSET);
  if (!set) return null;
  const value = (name: string) => set.properties.find((property) => property.name === name)?.value;
  const elementGlobalId = value(DERIVATION_ELEMENT_PROPERTY);
  const c = DERIVATION_AXIS_PROPERTIES.map(value);
  if (typeof elementGlobalId !== 'string' || !c.every((v): v is number => typeof v === 'number' && Number.isFinite(v))) return null;
  return { elementGlobalId, axis: [[c[0], c[1], c[2]], [c[3], c[4], c[5]]] };
}

/** The consistency issues of a parsed file. Physical elements are read only when a rule can use them. */
export function structuralConsistencyIssues(store: IfcDataStore, options: StructuralConsistencyIssuesOptions = {}): StructuralConsistencyIssue[] {
  const { physicalAxes, ...settings } = options;
  const structural = extractStructuralOnDemand(store);
  const facts = hasAnalyticalModel(structural) ? structuralConsistencyFacts(store, structural) : [];
  const geometry = physicalAxes && curveMemberGeometry(store, structural, physicalAxes);
  return checkStructuralConsistency(structural, facts, settings, geometry);
}
