/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Issue #5227: on a server-parsed store (no `source` bytes), the materially-associated
 * entity's material definition ids ARE resolved via the relationship graph, but
 * `extractAllMaterialsOnDemand` used to unconditionally discard them
 * (`if (!store.source?.length) return [];`), making a materially-associated entity
 * byte-identical to a genuinely unmaterialed one to every IDS material
 * facet. This exercises the fix through the real bridge/facet path — a
 * server-parsed-shaped store built with a real `RelationshipGraphBuilder`
 * `IfcRelAssociatesMaterial` edge, exactly as
 * `apps/viewer/src/utils/serverDataModel.ts` builds one — not a hand-built
 * fixture shaped like an assumption about the fix.
 */

import { describe, it, expect } from 'vitest';
import { RelationshipGraphBuilder, RelationshipType } from '@ifc-lite/data';
import type { IfcDataStore } from '@ifc-lite/parser';
import { createDataAccessor } from '../bridge/data-accessor.js';
import { checkMaterialFacet } from './material-facet.js';
import type { IDSMaterialFacet, IDSSimpleValue } from '../types.js';

const sv = (value: string): IDSSimpleValue => ({ type: 'simpleValue', value });

/** Server-parsed-shaped store: a real relationship-graph edge for
 *  `IfcRelAssociatesMaterial` (#200: #300 -> #100), `source` empty, no
 *  `onDemandMaterialMap` (only the WASM/full-parse path builds one). */
function serverStore(): IfcDataStore {
  const builder = new RelationshipGraphBuilder();
  // #200 = IfcRelAssociatesMaterial(...): #300 (the material
  // definition) is associated with #100 (the wall).
  builder.addEdge(300, 100, RelationshipType.AssociatesMaterial, 200);

  return {
    source: new Uint8Array(0),
    entityIndex: { byId: new Map(), byType: new Map() },
    relationships: builder.build(),
    onDemandMaterialMap: undefined,
  } as unknown as IfcDataStore;
}

/** Same shape, but #999 carries no material association edge at all. */
function unmaterialedServerStore(): IfcDataStore {
  const builder = new RelationshipGraphBuilder();
  builder.addEdge(300, 100, RelationshipType.AssociatesMaterial, 200);
  return {
    source: new Uint8Array(0),
    entityIndex: { byId: new Map(), byType: new Map() },
    relationships: builder.build(),
    onDemandMaterialMap: undefined,
  } as unknown as IfcDataStore;
}

const presenceFacet: IDSMaterialFacet = { type: 'material' };
const valueFacet: IDSMaterialFacet = {
  type: 'material',
  value: sv('Concrete'),
};

describe('checkMaterialFacet on a server-parsed (source-empty) store (#5227)', () => {
  it('a required "any material" facet now PASSES for a genuinely materially-associated entity (was a false FAIL)', () => {
    const accessor = createDataAccessor(serverStore());
    const result = checkMaterialFacet(presenceFacet, 100, accessor);
    expect(result.passed).toBe(true);
  });

  it('control: the same "any material" facet still FAILS (MATERIAL_MISSING) for a genuinely unmaterialed entity', () => {
    const accessor = createDataAccessor(unmaterialedServerStore());
    const result = checkMaterialFacet(presenceFacet, 999, accessor);
    expect(result.passed).toBe(false);
    expect(result.failure?.type).toBe('MATERIAL_MISSING');
  });

  it('a value-constrained facet reports MATERIAL_UNRESOLVED, not a silent PASS or a silent value-mismatch FAIL', () => {
    const accessor = createDataAccessor(serverStore());
    const result = checkMaterialFacet(valueFacet, 100, accessor);
    // Must not silently pass (we never verified the value)...
    expect(result.passed).toBe(false);
    // ...and must not be reported as if we found a real mismatch or as if
    // the entity were unmaterialed — a distinct, honest failure reason.
    expect(result.failure?.type).toBe('MATERIAL_UNRESOLVED');
    expect(result.failure?.type).not.toBe('MATERIAL_VALUE_MISMATCH');
    expect(result.failure?.type).not.toBe('MATERIAL_MISSING');
  });

  it('control: a genuinely unmaterialed entity still fails value-constrained facets as MATERIAL_MISSING, not UNRESOLVED', () => {
    const accessor = createDataAccessor(unmaterialedServerStore());
    const result = checkMaterialFacet(valueFacet, 999, accessor);
    expect(result.passed).toBe(false);
    expect(result.failure?.type).toBe('MATERIAL_MISSING');
  });
});
