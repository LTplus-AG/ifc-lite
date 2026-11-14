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
  DERIVATION_AXIS_PROPERTIES,
  DERIVATION_ELEMENT_PROPERTY,
  hasAnalyticalModel,
  isA,
  LOAD_BEARING_CLASSES,
  STRUCTURAL_DERIVATION_PSET,
  type PhysicalElementFact,
  type StructuralDerivationRecord,
  type StructuralConsistencyIssue,
  type StructuralConsistencyOptions,
  type StructuralLine,
} from './structural-consistency.js';
import { ItemGeometryReader } from './structural-item-geometry.js';
import { structuralCounterparts } from './structural-counterparts.js';
import { extractStructuralOnDemand } from './structural-extractor.js';
import type { StructuralExtraction } from './structural-types.js';

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
 * The edge of each curve member assigned to an element in `physicalAxes`, in
 * IFC world metres: the only members the axis-drift rule can compare.
 */
function curveMemberLines(store: IfcDataStore, structural: StructuralExtraction, physicalAxes: ReadonlyMap<number, StructuralLine>): Map<number, StructuralLine> {
  const reader = new ItemGeometryReader(store);
  const lines = new Map<number, StructuralLine>();
  for (const member of structural.members) {
    if (!isA(member.type, ['IfcStructuralCurveMember']) || !structuralCounterparts(structural, member.expressId)?.expressIds.some((id) => physicalAxes.has(id))) continue;
    const shape = reader.shape(member.expressId);
    if (shape?.kind === 'edge') lines.set(member.expressId, [shape.start, shape.end]);
  }
  return lines;
}

/** The derivation record on each of `memberIds`, when it is complete: a GlobalId and six finite coordinates. */
function derivationRecords(store: IfcDataStore, memberIds: Iterable<number>): Map<number, StructuralDerivationRecord> {
  const records = new Map<number, StructuralDerivationRecord>();
  for (const memberId of memberIds) {
    const set = store.getProperties(memberId).find((pset) => pset.name === STRUCTURAL_DERIVATION_PSET);
    if (!set) continue;
    const value = (name: string) => set.properties.find((property) => property.name === name)?.value;
    const elementGlobalId = value(DERIVATION_ELEMENT_PROPERTY);
    const c = DERIVATION_AXIS_PROPERTIES.map(value);
    if (typeof elementGlobalId !== 'string' || !c.every((v): v is number => typeof v === 'number' && Number.isFinite(v))) continue;
    records.set(memberId, { elementGlobalId, axis: [[c[0], c[1], c[2]], [c[3], c[4], c[5]]] });
  }
  return records;
}

/** The consistency issues of a parsed file. Physical elements are read only when a rule can use them. */
export function structuralConsistencyIssues(store: IfcDataStore, options: StructuralConsistencyIssuesOptions = {}): StructuralConsistencyIssue[] {
  const { physicalAxes, ...settings } = options;
  const structural = extractStructuralOnDemand(store);
  const facts = hasAnalyticalModel(structural) ? structuralConsistencyFacts(store, structural) : [];
  const geometry = physicalAxes && {
    physicalAxes,
    memberLines: curveMemberLines(store, structural, physicalAxes),
    derivationRecords: derivationRecords(store, structural.members.map((member) => member.expressId)),
  };
  return checkStructuralConsistency(structural, facts, settings, geometry);
}
