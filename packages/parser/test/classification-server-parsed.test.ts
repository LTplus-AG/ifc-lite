/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Issue #3948: on a server-parsed store (no `source` bytes, no
 * `onDemandClassificationMap`), `extractClassificationsOnDemand` resolves a
 * genuinely classified entity's `classRefIds` via the relationship graph
 * (the `else if (store.relationships)` fallback exists exactly for this),
 * then used to unconditionally discard the result with a bare `return []`
 * right after — making a classified entity byte-identical to a genuinely
 * unclassified one.
 *
 * These tests build the store the way the real server-parsed path does:
 * a real `RelationshipGraphBuilder` edge for `IfcRelAssociatesClassification`
 * (not a hand-rolled `onDemandClassificationMap`, which only the WASM/full
 * parse path ever populates), `source` empty, matching
 * `apps/viewer/src/utils/serverDataModel.ts`'s shape.
 */

import { describe, it, expect } from 'vitest';
import { RelationshipGraphBuilder, RelationshipType } from '@ifc-lite/data';
import { extractClassificationsOnDemand } from '../src/columnar-parser.js';
import type { IfcDataStore } from '../src/columnar-parser.js';
import type { EntityRef } from '../src/types.js';

/** Minimal server-parsed-shaped store: a real relationship-graph edge proves
 *  classification; no `onDemandClassificationMap`; `source` is empty. */
function serverParsedStore(opts: {
  /** entityId -> classRefId edges to add (IfcRelAssociatesClassification) */
  classificationEdges: Array<{ relId: number; classRefId: number; entityId: number }>;
}): IfcDataStore {
  const builder = new RelationshipGraphBuilder();
  for (const e of opts.classificationEdges) {
    builder.addEdge(e.classRefId, e.entityId, RelationshipType.AssociatesClassification, e.relId);
  }

  const byId = new Map<number, EntityRef>();
  const byType = new Map<string, number[]>();

  return {
    source: new Uint8Array(0), // server-parsed: no raw STEP bytes
    entityIndex: { byId, byType },
    relationships: builder.build(),
    onDemandClassificationMap: undefined,
  } as unknown as IfcDataStore;
}

describe('extractClassificationsOnDemand on a server-parsed (source-empty) store (#3948)', () => {
  it('RED/GREEN: a genuinely classified entity is no longer byte-identical to an unclassified one', () => {
    // #200 = IfcRelAssociatesClassification(...): #300 -> #100
    const store = serverParsedStore({
      classificationEdges: [{ relId: 200, classRefId: 300, entityId: 100 }],
    });

    const classified = extractClassificationsOnDemand(store, 100);
    const unclassified = extractClassificationsOnDemand(store, 999);

    // The core bug: before the fix, both were `[]` — indistinguishable.
    expect(classified.length).toBeGreaterThan(0);
    expect(unclassified).toEqual([]);
    expect(classified).not.toEqual(unclassified);
  });

  it('marks the resolved-but-unreadable entry `unresolved: true` with no fabricated fields', () => {
    const store = serverParsedStore({
      classificationEdges: [{ relId: 200, classRefId: 300, entityId: 100 }],
    });

    const result = extractClassificationsOnDemand(store, 100);
    expect(result).toEqual([{ unresolved: true }]);
  });

  it('control: a genuinely unclassified entity still reports "none", distinguishably', () => {
    const store = serverParsedStore({
      classificationEdges: [{ relId: 200, classRefId: 300, entityId: 100 }],
    });

    const result = extractClassificationsOnDemand(store, 999);
    expect(result).toEqual([]);
    expect(result.some((c) => c.unresolved)).toBe(false);
  });

  it('one unresolved entry per resolved classRefId (type-level + instance-level classifications both counted)', () => {
    const builder = new RelationshipGraphBuilder();
    // Instance #100 classified directly by #300.
    builder.addEdge(300, 100, RelationshipType.AssociatesClassification, 200);
    // Instance #100 is of type #50, which is classified by #301.
    builder.addEdge(50, 100, RelationshipType.DefinesByType, 201);
    builder.addEdge(301, 50, RelationshipType.AssociatesClassification, 202);

    const store = {
      source: new Uint8Array(0),
      entityIndex: { byId: new Map(), byType: new Map() },
      relationships: builder.build(),
      onDemandClassificationMap: undefined,
    } as unknown as IfcDataStore;

    const result = extractClassificationsOnDemand(store, 100);
    expect(result).toEqual([{ unresolved: true }, { unresolved: true }]);
  });
});
