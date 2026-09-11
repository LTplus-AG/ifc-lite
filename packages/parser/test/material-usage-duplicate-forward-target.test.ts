/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression for a documented-but-untested invariant in
 * `buildMaterialUsageIndex`: duplicate forward `DefinesByType` edges
 * (malformed double-typing — the same type→occurrence pair asserted by two
 * distinct `IfcRelDefinesByType` rows, or a single relation whose
 * `RelatedObjects` lists the same occurrence twice) must not double that
 * occurrence's contribution to a material's usage row.
 *
 * Uses the server-shaped (source-less, facade-graph) store, same as
 * `material-fraction-and-associations.test.ts`, so `getRelated(typeId,
 * DefinesByType, 'forward')` can be made to return a literal duplicate
 * target without depending on how any particular relationship-graph
 * implementation would (or wouldn't) already dedupe its edges.
 */

import { describe, it, expect } from 'vitest';
import { RelationshipType } from '@ifc-lite/data';
import { buildMaterialUsageIndex } from '../src/material-resolver.js';
import type { IfcDataStore } from '../src/columnar-parser.js';
import type { EntityRef } from '../src/types.js';

type Edge = { target: number; type: RelationshipType; relationshipId: number };

function facadeGraph(forwardEdges: Map<number, Edge[]>, inverseEdges: Map<number, Edge[]>) {
    const accessor = (edges: Map<number, Edge[]>) => ({
        offsets: new Map<number, number>(),
        counts: new Map<number, number>(),
        edgeTargets: new Uint32Array(0),
        edgeTypes: new Uint16Array(0),
        edgeRelIds: new Uint32Array(0),
        getEdges: (id: number, type?: RelationshipType) => {
            const e = edges.get(id) || [];
            return type !== undefined ? e.filter((x) => x.type === type) : e;
        },
        getTargets: (id: number, type?: RelationshipType) => {
            const e = edges.get(id) || [];
            return (type !== undefined ? e.filter((x) => x.type === type) : e).map((x) => x.target);
        },
        hasAnyEdges: (id: number) => (edges.get(id)?.length ?? 0) > 0,
    });
    return {
        forward: accessor(forwardEdges),
        inverse: accessor(inverseEdges),
        getRelated: (id: number, type: RelationshipType, direction: 'forward' | 'inverse') => {
            const edges = (direction === 'forward' ? forwardEdges : inverseEdges).get(id) || [];
            return edges.filter((e) => e.type === type).map((e) => e.target);
        },
        hasRelationship: () => false,
        getRelationshipsBetween: () => [],
    };
}

function buildStore(): IfcDataStore {
    // #11 door occurrence, #20 door type, #30 material. Type #20 carries the
    // material association; #20 -> #11 is asserted by TWO distinct
    // IfcRelDefinesByType rows (relationshipId 1 and 2) — malformed, but the
    // comment in buildMaterialUsageIndex explicitly claims this must not
    // double-count.
    const byId = new Map<number, EntityRef>([
        [11, { expressId: 11, type: 'IFCDOOR', byteOffset: 0, byteLength: 0, lineNumber: 0 }],
        [20, { expressId: 20, type: 'IFCDOORTYPE', byteOffset: 0, byteLength: 0, lineNumber: 0 }],
        [30, { expressId: 30, type: 'IFCMATERIAL', byteOffset: 0, byteLength: 0, lineNumber: 0 }],
    ]);
    const AM = RelationshipType.AssociatesMaterial;
    const DT = RelationshipType.DefinesByType;
    const forwardEdges = new Map<number, Edge[]>([
        [30, [{ target: 20, type: AM, relationshipId: 0 }]],
        // Duplicate forward DefinesByType edges: two relations, same pair.
        [20, [
            { target: 11, type: DT, relationshipId: 1 },
            { target: 11, type: DT, relationshipId: 2 },
        ]],
    ]);
    const inverseEdges = new Map<number, Edge[]>([
        [20, [{ target: 30, type: AM, relationshipId: 0 }]],
        [11, [{ target: 20, type: DT, relationshipId: 1 }, { target: 20, type: DT, relationshipId: 2 }]],
    ]);
    return {
        source: new Uint8Array(0),
        entityIndex: { byId, byType: new Map<string, number[]>() },
        relationships: facadeGraph(forwardEdges, inverseEdges),
        entities: { getName: (id: number) => (id === 30 ? 'Concrete' : '') },
    } as unknown as IfcDataStore;
}

describe('buildMaterialUsageIndex duplicate forward DefinesByType edges (undefended dedup)', () => {
    it('yields exactly one unmultiplied row for the (material, occurrence) pair', () => {
        const store = buildStore();
        const usage = buildMaterialUsageIndex(store);

        const concrete = usage.get(30);
        expect(concrete).toBeDefined();
        // Exactly one entry for occurrence #11 — not one per duplicate edge —
        // and its weight is the leaf's own weight (1), never doubled.
        expect(concrete!.entries).toEqual([{ entityId: 11, weight: 1 }]);
    });
});
