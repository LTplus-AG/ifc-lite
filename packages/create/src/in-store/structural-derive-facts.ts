/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The facts step: read a loaded model, as the next export would write it,
 * into the plain physical facts the planner takes. No idealisation happens
 * here; see `structural-derive-types.ts` for the rules.
 */

import { iterateEffectiveEntityIds, type MutablePropertyView, type StoreEditor } from '@ifc-lite/mutations';
import {
  effectiveMetadataRecord, extractStructuralOnDemand, extractTypePropertiesOnDemand, structuralCounterparts,
  type IfcDataStore, type StructuralExtraction, type StructuralExtractionView,
} from '@ifc-lite/parser';
import { listStoreys } from './generate-spaces-all.js';
import { safeLengthUnitScale } from './length-unit-scale.js';
import { createStyleEntityReader } from './style-entity-reader.js';
import { readElementShape } from './structural-derive-shape.js';
import type { DerivationElementRole, PhysicalElementFact, StructuralDerivationFacts } from './structural-derive-types.js';

/** STEP class to [reported class, role]. Subtypes report as their parent. */
const ELEMENT_CLASSES: Record<string, [string, DerivationElementRole]> = {
  IFCBEAM: ['IfcBeam', 'curve'], IFCBEAMSTANDARDCASE: ['IfcBeam', 'curve'],
  IFCCOLUMN: ['IfcColumn', 'curve'], IFCCOLUMNSTANDARDCASE: ['IfcColumn', 'curve'],
  IFCMEMBER: ['IfcMember', 'curve'], IFCMEMBERSTANDARDCASE: ['IfcMember', 'curve'],
  IFCSLAB: ['IfcSlab', 'surface'], IFCSLABSTANDARDCASE: ['IfcSlab', 'surface'], IFCSLABELEMENTEDCASE: ['IfcSlab', 'surface'],
  IFCWALL: ['IfcWall', 'surface'], IFCWALLSTANDARDCASE: ['IfcWallStandardCase', 'surface'], IFCWALLELEMENTEDCASE: ['IfcWall', 'surface'],
  IFCFOOTING: ['IfcFooting', 'support'], IFCPILE: ['IfcPile', 'support'],
};

/** The live structural read model, including items created this session. */
export function liveStructuralExtraction(store: IfcDataStore, view: MutablePropertyView): StructuralExtraction {
  const live: StructuralExtractionView = {
    isDeleted: (id) => view.isDeleted(id),
    getNewEntities: () => view.getNewEntities(),
    getNewEntitiesOfType: (type) => view.getNewEntitiesOfType(type),
    getNewEntity: (id) => view.getNewEntity(id),
    getTypeMutations: () => view.getTypeMutations(),
    getTombstones: () => view.getTombstones(),
    readEntity: (expressId) => {
      const record = effectiveMetadataRecord(store, expressId, view);
      return record ? { expressId, type: record.type, attrs: record.attributes, globalId: typeof record.attributes[0] === 'string' ? record.attributes[0] : '' } : undefined;
    },
  };
  return extractStructuralOnDemand(store, live);
}

function asBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const v = value.replace(/\./g, '').toUpperCase();
    if (v === 'T' || v === 'TRUE') return true;
    if (v === 'F' || v === 'FALSE') return false;
  }
  return null;
}

type Sets = ReadonlyArray<{ name: string; properties: ReadonlyArray<{ name: string; value: unknown }> }>;
function loadBearingIn(sets: Sets): boolean | null {
  for (const set of sets) {
    if (!/^Pset_\w+Common$/.test(set.name)) continue;
    const value = asBoolean(set.properties.find((p) => p.name === 'LoadBearing')?.value);
    if (value !== null) return value;
  }
  return null;
}

/** Occurrence `Pset_*Common.LoadBearing`, then the type's. */
function readLoadBearing(store: IfcDataStore, view: MutablePropertyView, id: number): boolean | null {
  return loadBearingIn(view.getForEntity(id)) ?? loadBearingIn(extractTypePropertiesOnDemand(store, id)?.properties ?? []);
}

export function readStructuralDerivationFacts(store: IfcDataStore, editor: StoreEditor): StructuralDerivationFacts {
  const view = editor.getMutationView();
  const read = createStyleEntityReader(store, editor);
  const reader = { entity: read };
  const metres = store.source.byteLength > 0 ? safeLengthUnitScale(store.source, store.entityIndex, 'readStructuralDerivationFacts') ?? 1 : 1;
  const structural = liveStructuralExtraction(store, view);
  const elements: PhysicalElementFact[] = [];
  for (const { expressId, type } of iterateEffectiveEntityIds(store, view, Object.keys(ELEMENT_CLASSES))) {
    const known = ELEMENT_CLASSES[type.toUpperCase()];
    if (!known) continue;
    const [reportedType, role] = known;
    const name = read(expressId)?.attributes[2];
    const shape = readElementShape(reader, expressId, metres, role === 'curve');
    elements.push({
      expressId,
      type: reportedType,
      role,
      name: typeof name === 'string' ? name : null,
      storeyId: store.spatialHierarchy?.elementToStorey.get(expressId) ?? null,
      loadBearing: role === 'support' ? null : readLoadBearing(store, view, expressId),
      idealised: structuralCounterparts(structural, expressId)?.side === 'analytical',
      ...shape.axis ? { axis: shape.axis } : {},
      ...shape.prism ? { prism: shape.prism } : {},
      ...shape.issue && !shape.prism ? { shapeIssue: shape.issue } : {},
    });
  }
  const storeys = listStoreys(store);
  const lowest = storeys.reduce<(typeof storeys)[number] | null>((low, s) => (low === null || s.elevation < low.elevation ? s : low), null);
  return { elements, defaultStoreyId: lowest?.id ?? null };
}
