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
