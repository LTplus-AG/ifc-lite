/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Multiple IfcRelAssociatesMaterial per element (#1755 follow-up sweep).
 *
 * An element may legally carry several material associations (e.g. a layer
 * set usage plus a plain fallback IfcMaterial). Previously the single-entry
 * `onDemandMaterialMap` kept whichever rel the parser scanned LAST, the cache
 * rebuild could pick a DIFFERENT winner (bucket order vs file order), and
 * every consumer saw only that one association.
 *
 * Now:
 *  - the map's "primary" is deterministic: lowest rel express id wins;
 *  - `resolveAllMaterialDefIds` / `extractAllMaterialsOnDemand` surface ALL
 *    associations (rel-express-id order) from the relationship graph;
 *  - `buildMaterialUsageIndex` lists the element under every material;
 *  - transport round-trips the deterministic map verbatim.
 *
 * Full-pipeline tests (scan → parseLite) so the graph edges and rel ids are
 * the real ones, not hand-built.
 */

import { describe, it, expect } from 'vitest';
import { StepTokenizer } from '../src/tokenizer.js';
import { ColumnarParser } from '../src/columnar-parser.js';
import {
    buildMaterialUsageIndex,
    extractMaterialsOnDemand,
    extractAllMaterialsOnDemand,
    resolveAllMaterialDefIds,
    resolveMaterialDefId,
} from '../src/material-resolver.js';
import { toTransport, fromTransport } from '../src/data-store-transport.js';
import type { EntityRef } from '../src/types.js';

function scan(ifc: string): { source: Uint8Array; entityRefs: EntityRef[] } {
    const source = new TextEncoder().encode(ifc);
    const tokenizer = new StepTokenizer(source);
    const entityRefs: EntityRef[] = [];
    for (const ref of tokenizer.scanEntitiesFast()) {
        entityRefs.push({
            expressId: ref.expressId,
            type: ref.type,
            byteOffset: ref.offset,
            byteLength: ref.length,
            lineNumber: ref.line,
        });
    }
    return { source, entityRefs };
}

async function parse(ifc: string) {
    const { source, entityRefs } = scan(ifc);
    const parser = new ColumnarParser();
    return parser.parseLite(source.buffer.slice(0) as ArrayBuffer, entityRefs, {});
}

// Wall #100 carries TWO associations: rel #330 → layer set #312, rel #331 →
// plain IfcMaterial #302 ('Fallback'). Door #110 is typed by #200 whose set
// is #322; door #120 additionally has its OWN association (rel #333 → #301).
const BASE = `#100=IFCWALL('0Wall00000000000000001',$,'Wall',$,$,$,$,$,$);
#110=IFCDOOR('0Door00000000000000001',$,'Door',$,$,$,$,$,2.,0.9,$,$,$);
#120=IFCDOOR('0Door00000000000000002',$,'Door',$,$,$,$,$,2.,0.9,$,$,$);
#200=IFCDOORTYPE('0DoorType0000000000001',$,'DoorType',$,$,$,$,$,$,.DOOR.,.SINGLE_SWING_LEFT.,$);
#210=IFCRELDEFINESBYTYPE('0RelType00000000000001',$,$,$,(#110,#120),#200);
#300=IFCMATERIAL('Brick',$,$);
#301=IFCMATERIAL('OwnDoorMat',$,$);
#302=IFCMATERIAL('Fallback',$,$);
#303=IFCMATERIAL('TypeDoorMat',$,$);
#310=IFCMATERIALLAYER(#300,0.2,$,'Core',$,$,$);
#312=IFCMATERIALLAYERSET((#310),'Wall Buildup',$);
#322=IFCMATERIALCONSTITUENTSET('DoorSet',$,(#323));
#323=IFCMATERIALCONSTITUENT('Body',$,#303,$,$);`;

const REL_A = `#330=IFCRELASSOCIATESMATERIAL('0RelMat000000000000001',$,$,$,(#100),#312);`;
const REL_B = `#331=IFCRELASSOCIATESMATERIAL('0RelMat000000000000002',$,$,$,(#100),#302);`;
const REL_TYPE = `#332=IFCRELASSOCIATESMATERIAL('0RelMat000000000000003',$,$,$,(#200),#322);`;
const REL_OWN = `#333=IFCRELASSOCIATESMATERIAL('0RelMat000000000000004',$,$,$,(#120),#301);`;

describe('multiple IfcRelAssociatesMaterial per element', () => {
    it('map winner is the LOWEST rel express id regardless of file order', async () => {
        const inOrder = await parse([BASE, REL_A, REL_B, REL_TYPE, REL_OWN].join('\n'));
        const reversed = await parse([BASE, REL_OWN, REL_TYPE, REL_B, REL_A].join('\n'));

        // Rel #330 (layer set #312) has the lowest express id → primary at
        // list index 0; the map keeps EVERY association in rel-id order.
        expect(inOrder.onDemandMaterialMap?.get(100)).toEqual([312, 302]);
        expect(reversed.onDemandMaterialMap?.get(100)).toEqual([312, 302]);
        expect(resolveMaterialDefId(inOrder, 100)).toBe(312);
        expect(extractMaterialsOnDemand(reversed, 100)?.type).toBe('MaterialLayerSet');
    });

    it('resolveAllMaterialDefIds returns every association in rel-id order', async () => {
        const store = await parse([BASE, REL_B, REL_A].join('\n')); // file order ≠ rel order
        expect(resolveAllMaterialDefIds(store, 100)).toEqual([312, 302]);

        const infos = extractAllMaterialsOnDemand(store, 100);
        expect(infos.map((i) => i.type)).toEqual(['MaterialLayerSet', 'Material']);
        expect(infos[1].name).toBe('Fallback');
    });

    it('type fallback still applies when the occurrence has no association', async () => {
        const store = await parse([BASE, REL_TYPE].join('\n'));
        expect(resolveAllMaterialDefIds(store, 110)).toEqual([322]);
        // Occurrence association SUPPRESSES the type's (IFC precedence).
        const storeOwn = await parse([BASE, REL_TYPE, REL_OWN].join('\n'));
        expect(resolveAllMaterialDefIds(storeOwn, 120)).toEqual([301]);
        expect(resolveAllMaterialDefIds(storeOwn, 110)).toEqual([322]);
    });

    it('buildMaterialUsageIndex lists the element under EVERY associated material', async () => {
        const store = await parse([BASE, REL_A, REL_B].join('\n'));
        const usage = buildMaterialUsageIndex(store);
        const byName = new Map([...usage.values()].map((u) => [u.name, u]));

        // Layer set fans out to Brick; second association adds Fallback.
        expect(byName.get('Brick')!.entries.map((e) => e.entityId)).toEqual([100]);
        expect(byName.get('Fallback')!.entries.map((e) => e.entityId)).toEqual([100]);
    });

    it('a TYPE with two associations lists its occurrences under both materials', async () => {
        // Type #200 carries the constituent set (rel #332) AND a plain
        // fallback material (rel #334). Doors #110/#120 inherit both.
        const REL_TYPE_2 = `#334=IFCRELASSOCIATESMATERIAL('0RelMat000000000000005',$,$,$,(#200),#302);`;
        const store = await parse([BASE, REL_TYPE, REL_TYPE_2].join('\n'));
        const usage = buildMaterialUsageIndex(store);
        const byName = new Map([...usage.values()].map((u) => [u.name, u]));

        expect(byName.get('TypeDoorMat')!.entries.map((e) => e.entityId).sort()).toEqual([110, 120]);
        expect(byName.get('Fallback')!.entries.map((e) => e.entityId).sort()).toEqual([110, 120]);
        // The type entity itself never appears.
        for (const u of usage.values()) {
            expect(u.entries.some((e) => e.entityId === 200)).toBe(false);
        }
    });

    it('accumulates weights when two associations resolve to the SAME base material', async () => {
        // Wall #100: layer set whose only layer is Brick (#300, weight 1)
        // PLUS a direct association to Brick itself. The wall must appear
        // ONCE under Brick with the weights combined (1 + 1 = 2), not with
        // whichever association happened to come first (rel-order dependence).
        const REL_SAME = `#335=IFCRELASSOCIATESMATERIAL('0RelMat000000000000006',$,$,$,(#100),#300);`;
        const store = await parse([BASE, REL_A, REL_SAME].join('\n'));
        const usage = buildMaterialUsageIndex(store);
        const brick = [...usage.values()].find((u) => u.name === 'Brick')!;

        const rows = brick.entries.filter((e) => e.entityId === 100);
        expect(rows).toHaveLength(1); // one row → element counted once
        expect(rows[0].weight).toBeCloseTo(2, 6); // both contributions kept
    });

    it('transport round-trips the deterministic map verbatim', async () => {
        const store = await parse([BASE, REL_B, REL_A].join('\n'));
        const envelope = toTransport(store);
        const restored = fromTransport(envelope.payload, store.source);
        expect([...restored.onDemandMaterialMap!.entries()].sort())
            .toEqual([...store.onDemandMaterialMap!.entries()].sort());
        expect(restored.onDemandMaterialMap!.get(100)).toEqual([312, 302]);
    });
});
