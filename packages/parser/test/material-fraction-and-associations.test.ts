/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regressions for the material-usage-index defects:
 *  - multiple IfcRelAssociatesMaterial per element are preserved (not last-wins)
 *  - buildMaterialUsageIndex falls back to the relationship graph when the
 *    parser's onDemandMaterialMap is absent (server-loaded models), and does
 *    not cache an empty index built from a store that had no map and no source
 *  - IfcMaterialConstituent siblings WITHOUT an explicit Fraction share the
 *    remainder instead of collapsing to weight 0
 */

import { describe, it, expect } from 'vitest';
import { RelationshipType } from '@ifc-lite/data';
import { StepTokenizer } from '../src/tokenizer.js';
import { ColumnarParser, type IfcDataStore } from '../src/columnar-parser.js';
import { buildMaterialUsageIndex, collectMaterialLeaves } from '../src/material-resolver.js';
import type { EntityRef } from '../src/types.js';

function scan(ifc: string): { source: Uint8Array; entityRefs: EntityRef[] } {
    const source = new TextEncoder().encode(ifc);
    const tokenizer = new StepTokenizer(source);
    const entityRefs: EntityRef[] = [];
    for (const r of tokenizer.scanEntitiesFast()) {
        entityRefs.push({
            expressId: r.expressId,
            type: r.type,
            byteOffset: r.offset,
            byteLength: r.length,
            lineNumber: r.line,
        });
    }
    return { source, entityRefs };
}

// Wall #100 carries TWO occurrence-level material associations (Alpha + Beta) —
// valid in the wild, and the case the old last-wins `.set` dropped. A separate
// constituent set exercises partial fractions.
const IFC = `#1=IFCPROJECT('0Project00000000000001',$,'P',$,$,$,$,$,$);
#100=IFCWALL('0Wall00000000000000001',$,'Wall',$,$,$,$,$,$);
#300=IFCMATERIAL('Alpha',$,$);
#301=IFCMATERIAL('Beta',$,$);
#310=IFCMATERIAL('Core',$,$);
#320=IFCMATERIAL('Skin',$,$);
#330=IFCRELASSOCIATESMATERIAL('0Rel000000000000000a1',$,$,$,(#100),#300);
#331=IFCRELASSOCIATESMATERIAL('0Rel000000000000000a2',$,$,$,(#100),#301);
#400=IFCMATERIALCONSTITUENT('CoreC',$,#310,0.6,$);
#401=IFCMATERIALCONSTITUENT('SkinC',$,#320,$,$);
#410=IFCMATERIALCONSTITUENTSET('Buildup',$,(#400,#401));`;

async function parse(): Promise<IfcDataStore> {
    const { source, entityRefs } = scan(IFC);
    const parser = new ColumnarParser();
    return parser.parseLite(source.buffer.slice(0) as ArrayBuffer, entityRefs, {});
}

describe('multiple material associations per element (list-valued map)', () => {
    it('preserves both associations rather than last-wins', async () => {
        const store = await parse();
        expect(store.onDemandMaterialMap?.get(100)).toEqual([300, 301]);

        const usage = buildMaterialUsageIndex(store);
        const byName = new Map([...usage.values()].map((u) => [u.name, u]));
        expect(byName.get('Alpha')!.entries.map((e) => e.entityId)).toEqual([100]);
        expect(byName.get('Beta')!.entries.map((e) => e.entityId)).toEqual([100]);
    });
});

describe('buildMaterialUsageIndex relationship-graph fallback', () => {
    it('resolves usage from the graph when onDemandMaterialMap is absent', async () => {
        const base = await parse();
        // Simulate a server-loaded store: relationships + source present, but no
        // forward onDemandMaterialMap. A fresh object => a fresh WeakMap cache.
        const store = { ...base, onDemandMaterialMap: undefined } as IfcDataStore;

        const usage = buildMaterialUsageIndex(store);
        const byName = new Map([...usage.values()].map((u) => [u.name, u]));
        expect(byName.get('Alpha')!.entries.map((e) => e.entityId)).toEqual([100]);
        expect(byName.get('Beta')!.entries.map((e) => e.entityId)).toEqual([100]);
    });

    it('does not cache an empty index from a store with no map and no source', async () => {
        const base = await parse();
        // Store with neither a material map nor a source (nor relationships):
        // the index is empty and MUST NOT be memoised, so a later-populated
        // store object can still build a real index.
        const store = {
            ...base,
            onDemandMaterialMap: undefined,
            relationships: undefined,
            source: new Uint8Array(0),
        } as unknown as IfcDataStore;

        expect(buildMaterialUsageIndex(store).size).toBe(0);

        // Populate the SAME object and rebuild — a cached empty would mask this.
        store.onDemandMaterialMap = base.onDemandMaterialMap;
        (store as { source: Uint8Array }).source = base.source!;
        store.relationships = base.relationships;

        const usage = buildMaterialUsageIndex(store);
        const byName = new Map([...usage.values()].map((u) => [u.name, u]));
        expect(byName.get('Alpha')!.entries.map((e) => e.entityId)).toEqual([100]);
    });
});

describe('IfcMaterialConstituent partial fractions', () => {
    it('shares the remainder with un-fractioned siblings ({A:0.6, B:none})', async () => {
        const store = await parse();
        const leaves = collectMaterialLeaves(store, 410);
        const byId = new Map(leaves.map((l) => [l.id, l.weight]));
        expect(byId.get(310)).toBeCloseTo(0.6, 6); // explicit
        expect(byId.get(320)).toBeCloseTo(0.4, 6); // shares remaining 1 - 0.6
    });
});

// Adversarial fraction shapes: every constituent set must yield weights that
// sum to exactly 1, whatever mix of explicit / missing / malformed fractions
// the file carries - otherwise MaterialTotalsPanel over- or under-reports the
// element's volume/area/weight.
const FRACTION_IFC = `#1=IFCPROJECT('0Project00000000000001',$,'P',$,$,$,$,$,$);
#310=IFCMATERIAL('M1',$,$);
#311=IFCMATERIAL('M2',$,$);
#312=IFCMATERIAL('M3',$,$);
#400=IFCMATERIALCONSTITUENT('A',$,#310,1.0,$);
#401=IFCMATERIALCONSTITUENT('B',$,#311,$,$);
#410=IFCMATERIALCONSTITUENTSET('FullPlusUnset',$,(#400,#401));
#420=IFCMATERIALCONSTITUENT('C',$,#310,0.5,$);
#421=IFCMATERIALCONSTITUENT('D',$,#311,$,$);
#422=IFCMATERIALCONSTITUENT('E',$,#312,$,$);
#430=IFCMATERIALCONSTITUENTSET('HalfPlusTwoUnset',$,(#420,#421,#422));
#440=IFCMATERIALCONSTITUENT('F',$,#310,0.1,$);
#441=IFCMATERIALCONSTITUENT('G',$,#311,0.2,$);
#450=IFCMATERIALCONSTITUENTSET('ExplicitSumBelowOne',$,(#440,#441));
#460=IFCMATERIALCONSTITUENT('H',$,#310,-0.5,$);
#461=IFCMATERIALCONSTITUENT('I',$,#311,0.,$);
#470=IFCMATERIALCONSTITUENTSET('AllMalformed',$,(#460,#461));`;

async function parseFractions(): Promise<IfcDataStore> {
    const { source, entityRefs } = scan(FRACTION_IFC);
    const parser = new ColumnarParser();
    return parser.parseLite(source.buffer.slice(0) as ArrayBuffer, entityRefs, {});
}

function weights(store: IfcDataStore, defId: number): Map<number, number> {
    return new Map(collectMaterialLeaves(store, defId).map((l) => [l.id, l.weight]));
}

describe('IfcMaterialConstituent fraction normalisation (weights sum to 1)', () => {
    it('renormalises {1.0, unset} instead of summing to 1.5', async () => {
        const store = await parseFractions();
        const w = weights(store, 410);
        expect(w.get(310)).toBeCloseTo(2 / 3, 6);
        expect(w.get(311)).toBeCloseTo(1 / 3, 6);
        expect((w.get(310) ?? 0) + (w.get(311) ?? 0)).toBeCloseTo(1, 9);
    });

    it('splits the remainder evenly for {0.5, unset, unset}', async () => {
        const store = await parseFractions();
        const w = weights(store, 430);
        expect(w.get(310)).toBeCloseTo(0.5, 6);
        expect(w.get(311)).toBeCloseTo(0.25, 6);
        expect(w.get(312)).toBeCloseTo(0.25, 6);
    });

    it('normalises an all-explicit set summing below 1 ({0.1, 0.2} -> 1/3, 2/3)', async () => {
        const store = await parseFractions();
        const w = weights(store, 450);
        expect(w.get(310)).toBeCloseTo(1 / 3, 6);
        expect(w.get(311)).toBeCloseTo(2 / 3, 6);
    });

    it('treats negative and zero fractions as unset (equal split, sum 1)', async () => {
        const store = await parseFractions();
        const w = weights(store, 470);
        expect(w.get(310)).toBeCloseTo(0.5, 6);
        expect(w.get(311)).toBeCloseTo(0.5, 6);
    });
});

// Duplicate and dangling associations: an element carrying the SAME definition
// twice (two IfcRelAssociatesMaterial rows) must not double-count, and an
// association pointing at a nonexistent entity must resolve to nothing.
const DUP_IFC = `#1=IFCPROJECT('0Project00000000000001',$,'P',$,$,$,$,$,$);
#100=IFCWALL('0Wall00000000000000001',$,'Wall',$,$,$,$,$,$);
#300=IFCMATERIAL('Alpha',$,$);
#330=IFCRELASSOCIATESMATERIAL('0Rel000000000000000b1',$,$,$,(#100),#300);
#331=IFCRELASSOCIATESMATERIAL('0Rel000000000000000b2',$,$,$,(#100),#300);
#332=IFCRELASSOCIATESMATERIAL('0Rel000000000000000b3',$,$,$,(#100),#999);`;

describe('duplicate and dangling material associations', () => {
    it('keeps one usage entry per element and drops the dangling definition', async () => {
        const { source, entityRefs } = scan(DUP_IFC);
        const parser = new ColumnarParser();
        const store = await parser.parseLite(source.buffer.slice(0) as ArrayBuffer, entityRefs, {});

        expect(store.onDemandMaterialMap?.get(100)).toEqual([300, 300, 999]);

        const usage = buildMaterialUsageIndex(store);
        const alpha = usage.get(300);
        expect(alpha).toBeDefined();
        // Duplicate association contributes once (seenPerMaterial dedup).
        expect(alpha!.entries).toEqual([{ entityId: 100, weight: 1 }]);
        // The dangling #999 produces no usage row at all.
        expect(usage.has(999)).toBe(false);
        expect(collectMaterialLeaves(store, 999)).toEqual([]);
    });
});

// The REAL server-store shape (apps/viewer convertServerDataModel): source is
// an EMPTY Uint8Array, there is no onDemandMaterialMap, and the relationship
// graph is a facade whose `inverse.offsets` is an EMPTY Map - only the
// getRelated/getEdges closures work. The fallback must still populate the
// usage index from AssociatesMaterial edges, surfacing each definition as an
// opaque full-weight leaf (set expansion needs the source buffer, which the
// server never ships).
describe('buildMaterialUsageIndex on a server-shaped (source-less, facade-graph) store', () => {
    type Edge = { target: number; type: RelationshipType; relationshipId: number };

    function facadeGraph(forwardEdges: Map<number, Edge[]>, inverseEdges: Map<number, Edge[]>) {
        const accessor = (edges: Map<number, Edge[]>) => ({
            offsets: new Map<number, number>(), // EMPTY, like convertServerDataModel
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

    function buildServerStore(): IfcDataStore {
        // #10 wall, #11/#12 doors typed by #20 IfcDoorType, #30/#31 material defs.
        const byId = new Map<number, EntityRef>([
            [10, { expressId: 10, type: 'IFCWALL', byteOffset: 0, byteLength: 0, lineNumber: 0 }],
            [11, { expressId: 11, type: 'IFCDOOR', byteOffset: 0, byteLength: 0, lineNumber: 0 }],
            [12, { expressId: 12, type: 'IFCDOOR', byteOffset: 0, byteLength: 0, lineNumber: 0 }],
            [20, { expressId: 20, type: 'IFCDOORTYPE', byteOffset: 0, byteLength: 0, lineNumber: 0 }],
            [30, { expressId: 30, type: 'IFCMATERIAL', byteOffset: 0, byteLength: 0, lineNumber: 0 }],
            [31, { expressId: 31, type: 'IFCMATERIALLAYERSET', byteOffset: 0, byteLength: 0, lineNumber: 0 }],
        ]);
        const AM = RelationshipType.AssociatesMaterial;
        const DT = RelationshipType.DefinesByType;
        const forwardEdges = new Map<number, Edge[]>([
            // material def -> elements
            [30, [{ target: 10, type: AM, relationshipId: 0 }]],
            // layer set -> DOOR TYPE (type-level association, must expand)
            [31, [{ target: 20, type: AM, relationshipId: 0 }]],
            // type -> occurrences
            [20, [{ target: 11, type: DT, relationshipId: 0 }, { target: 12, type: DT, relationshipId: 0 }]],
        ]);
        const inverseEdges = new Map<number, Edge[]>([
            [10, [{ target: 30, type: AM, relationshipId: 0 }]],
            [20, [{ target: 31, type: AM, relationshipId: 0 }]],
            [11, [{ target: 20, type: DT, relationshipId: 0 }]],
            [12, [{ target: 20, type: DT, relationshipId: 0 }]],
        ]);
        return {
            source: new Uint8Array(0), // exactly what convertServerDataModel ships
            entityIndex: { byId, byType: new Map<string, number[]>() },
            relationships: facadeGraph(forwardEdges, inverseEdges),
            entities: { getName: (id: number) => (id === 30 ? 'Concrete' : '') },
        } as unknown as IfcDataStore;
    }

    it('populates the index from AssociatesMaterial edges with opaque full-weight leaves', () => {
        const store = buildServerStore();
        const usage = buildMaterialUsageIndex(store);

        const concrete = usage.get(30);
        expect(concrete).toBeDefined();
        expect(concrete!.name).toBe('Concrete'); // via entities.getName
        expect(concrete!.entries).toEqual([{ entityId: 10, weight: 1 }]);

        // Type-level association expands to the two door occurrences.
        const layerSet = usage.get(31);
        expect(layerSet).toBeDefined();
        expect(layerSet!.entries.map((e) => e.entityId).sort()).toEqual([11, 12]);
        expect(layerSet!.entries.every((e) => e.weight === 1)).toBe(true);
        // The type itself gets no dead row.
        expect(layerSet!.entries.some((e) => e.entityId === 20)).toBe(false);
    });

    it('memoises the result for the server store (relationships count as inputs)', () => {
        const store = buildServerStore();
        const first = buildMaterialUsageIndex(store);
        expect(buildMaterialUsageIndex(store)).toBe(first);
    });
});
