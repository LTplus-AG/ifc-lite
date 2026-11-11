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
  effectiveStructuralView, expandTypes, extractStructuralOnDemand, extractTypePropertiesOnDemand, normalizeIfcTypeName,
  structuralCounterparts, type IfcDataStore, type StructuralExtraction,
} from '@ifc-lite/parser';
import { listStoreys } from './generate-spaces-all.js';
import { placementInAncestor, refId, transformBounds } from './host-geometry-frame.js';
import { safeLengthUnitScale } from './length-unit-scale.js';
import { localBodyExtent } from './resolve-host.js';
import { createStyleEntityReader, type StyleEntity } from './style-entity-reader.js';
import { scale } from './structural-derive-idealise.js';
import { DERIVATION_CLASSES } from './structural-derive-plan.js';
import { readElementShape } from './structural-derive-shape.js';
import type { PhysicalElementFact, StructuralDerivationFacts } from './structural-derive-types.js';

const FOOTINGS = new Set(['IfcFooting', 'IfcPile']);

/** The live structural read model, including items created this session. */
export function liveStructuralExtraction(store: IfcDataStore, view: MutablePropertyView): StructuralExtraction {
  return extractStructuralOnDemand(store, effectiveStructuralView(store, view));
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
  if (store.schemaVersion === 'IFC5') throw new Error('Structural derivation: IFC5 is not supported; use IFC2X3, IFC4 or IFC4X3');
  const view = editor.getMutationView();
  // Nothing is written while facts are read, so one parse per record is enough:
  // placements, profiles and storeys are shared by many elements.
  const live = createStyleEntityReader(store, editor);
  const cache = new Map<number, StyleEntity | null>();
  const read = (id: number) => {
    if (!cache.has(id)) cache.set(id, live(id));
    return cache.get(id)!;
  };
  const reader = { entity: read };
  const metres = store.source.byteLength > 0 ? safeLengthUnitScale(store.source, store.entityIndex, 'readStructuralDerivationFacts') ?? 1 : 1;
  const structural = liveStructuralExtraction(store, view);
  const elements: PhysicalElementFact[] = [];
  for (const { expressId, type: stepType } of iterateEffectiveEntityIds(store, view, expandTypes([...DERIVATION_CLASSES], store.schemaVersion))) {
    const type = normalizeIfcTypeName(stepType);
    const name = read(expressId)?.attributes[2];
    const fact: PhysicalElementFact = {
      expressId,
      type,
      name: typeof name === 'string' ? name : null,
      storeyId: store.spatialHierarchy?.elementToStorey.get(expressId) ?? null,
      loadBearing: null,
      idealised: false,
    };
    if (FOOTINGS.has(type)) {
      const placementId = refId(read(expressId)?.attributes[5]);
      const local = localBodyExtent(store, expressId, view);
      const frame = placementId === null ? null : placementInAncestor(reader, placementId, null);
      if (local && frame) {
        const world = transformBounds(local, frame);
        fact.bounds = { min: scale(world.min, metres), max: scale(world.max, metres) };
      } else fact.shapeIssue = 'the body or placement is unreadable';
    } else {
      fact.loadBearing = readLoadBearing(store, view, expressId);
      fact.idealised = structuralCounterparts(structural, expressId)?.side === 'analytical';
      Object.assign(fact, readElementShape(reader, expressId, metres, true));
    }
    elements.push(fact);
  }
  // listStoreys sorts by elevation, lowest first.
  return { elements, defaultStoreyId: listStoreys(store)[0]?.id ?? null };
}
