/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Issue #3948: on a server-parsed store (no `source` bytes), the classified
 * entity's classification ids ARE resolved via the relationship graph, but
 * `extractClassificationsOnDemand` used to unconditionally discard them
 * (`if (!store.source?.length) return [];`), making a classified entity
 * byte-identical to a genuinely unclassified one to every IDS classification
 * facet. This exercises the fix through the real bridge/facet path — a
 * server-parsed-shaped store built with a real `RelationshipGraphBuilder`
 * `IfcRelAssociatesClassification` edge, exactly as
 * `apps/viewer/src/utils/serverDataModel.ts` builds one — not a hand-built
 * fixture shaped like an assumption about the fix.
 */

import { describe, it, expect } from 'vitest';
import { RelationshipGraphBuilder, RelationshipType } from '@ifc-lite/data';
import type { IfcDataStore } from '@ifc-lite/parser';
import { createDataAccessor } from '../bridge/data-accessor.js';
import { checkClassificationFacet } from './classification-facet.js';
import type { IDSClassificationFacet, IDSSimpleValue } from '../types.js';

const sv = (value: string): IDSSimpleValue => ({ type: 'simpleValue', value });

/** Server-parsed-shaped store: a real relationship-graph edge for
 *  `IfcRelAssociatesClassification` (#200: #300 -> #100), `source` empty, no
 *  `onDemandClassificationMap` (only the WASM/full-parse path builds one). */
function serverStore(): IfcDataStore {
  const builder = new RelationshipGraphBuilder();
  // #200 = IfcRelAssociatesClassification(...): #300 (the classification
  // reference) classifies #100 (the wall).
  builder.addEdge(300, 100, RelationshipType.AssociatesClassification, 200);

  return {
    source: new Uint8Array(0),
    entityIndex: { byId: new Map(), byType: new Map() },
    relationships: builder.build(),
    onDemandClassificationMap: undefined,
  } as unknown as IfcDataStore;
}

/** Same shape, but #999 carries no classification edge at all. */
function unclassifiedServerStore(): IfcDataStore {
  const builder = new RelationshipGraphBuilder();
  builder.addEdge(300, 100, RelationshipType.AssociatesClassification, 200);
  return {
    source: new Uint8Array(0),
    entityIndex: { byId: new Map(), byType: new Map() },
    relationships: builder.build(),
    onDemandClassificationMap: undefined,
  } as unknown as IfcDataStore;
}

const presenceFacet: IDSClassificationFacet = { type: 'classification' };
const valueFacet: IDSClassificationFacet = {
  type: 'classification',
  value: sv('Ss_25_10'),
};
const systemFacet: IDSClassificationFacet = {
  type: 'classification',
  system: sv('Uniclass 2015'),
};

describe('checkClassificationFacet on a server-parsed (source-empty) store (#3948)', () => {
  it('a required "any classification" facet now PASSES for a genuinely classified entity (was a false FAIL)', () => {
    const accessor = createDataAccessor(serverStore());
    const result = checkClassificationFacet(presenceFacet, 100, accessor);
    expect(result.passed).toBe(true);
  });

  it('control: the same "any classification" facet still FAILS (CLASSIFICATION_MISSING) for a genuinely unclassified entity', () => {
    const accessor = createDataAccessor(unclassifiedServerStore());
    const result = checkClassificationFacet(presenceFacet, 999, accessor);
    expect(result.passed).toBe(false);
    expect(result.failure?.type).toBe('CLASSIFICATION_MISSING');
  });

  it('a value-constrained facet reports CLASSIFICATION_UNRESOLVED, not a silent PASS or a silent value-mismatch FAIL', () => {
    const accessor = createDataAccessor(serverStore());
    const result = checkClassificationFacet(valueFacet, 100, accessor);
    // Must not silently pass (we never verified the value)...
    expect(result.passed).toBe(false);
    // ...and must not be reported as if we found a real mismatch or as if
    // the entity were unclassified — a distinct, honest failure reason.
    expect(result.failure?.type).toBe('CLASSIFICATION_UNRESOLVED');
    expect(result.failure?.type).not.toBe('CLASSIFICATION_VALUE_MISMATCH');
    expect(result.failure?.type).not.toBe('CLASSIFICATION_MISSING');
  });

  it('a system-constrained facet also reports CLASSIFICATION_UNRESOLVED', () => {
    const accessor = createDataAccessor(serverStore());
    const result = checkClassificationFacet(systemFacet, 100, accessor);
    expect(result.passed).toBe(false);
    expect(result.failure?.type).toBe('CLASSIFICATION_UNRESOLVED');
  });

  it('control: a genuinely unclassified entity still fails value-constrained facets as CLASSIFICATION_MISSING, not UNRESOLVED', () => {
    const accessor = createDataAccessor(unclassifiedServerStore());
    const result = checkClassificationFacet(valueFacet, 999, accessor);
    expect(result.passed).toBe(false);
    expect(result.failure?.type).toBe('CLASSIFICATION_MISSING');
  });
});
