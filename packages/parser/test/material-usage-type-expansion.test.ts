/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Integration regression for issue #1755 — the viewer's "By Material" tab
 * showed a single row for a model whose door materials were associated to the
 * IfcDoorType. `buildMaterialUsageIndex` iterated `onDemandMaterialMap`
 * verbatim, so type-associated materials were keyed to the TYPE entity, which
 * the tab's geometry filter then dropped. This exercises the FULL pipeline
 * (scan → parseLite → usage index) so the forward IfcRelDefinesByType edge
 * direction is validated against the real relationship graph, not hand-built
 * test edges.
 */

import { describe, it, expect } from 'vitest';
import { StepTokenizer } from '../src/tokenizer.js';
import { ColumnarParser } from '../src/columnar-parser.js';
import { buildMaterialUsageIndex, extractMaterialsOnDemand } from '../src/material-resolver.js';
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

// Mirrors the #1755 report: wall with an occurrence-level IfcMaterial
// ('Unknown'), two doors whose constituent sets (wood1 / wood2) hang off
// their IfcDoorTypes via IfcRelAssociatesMaterial.
const IFC = `#1=IFCPROJECT('0Project00000000000001',$,'Repro 1755',$,$,$,$,$,$);
#100=IFCWALL('0Wall00000000000000001',$,'Wall',$,$,$,$,$,$);
#110=IFCDOOR('0Door00000000000000001',$,'Door',$,$,$,$,$,2.,0.9,$,$,$);
#120=IFCDOOR('0Door00000000000000002',$,'Door',$,$,$,$,$,2.,0.9,$,$,$);
#200=IFCDOORTYPE('0DoorType0000000000001',$,'DoorType-wood1',$,$,$,$,$,$,.DOOR.,.SINGLE_SWING_LEFT.,$);
#201=IFCDOORTYPE('0DoorType0000000000002',$,'DoorType-wood2',$,$,$,$,$,$,.DOOR.,.SINGLE_SWING_LEFT.,$);
#210=IFCRELDEFINESBYTYPE('0RelType00000000000001',$,$,$,(#110),#200);
#211=IFCRELDEFINESBYTYPE('0RelType00000000000002',$,$,$,(#120),#201);
#300=IFCMATERIAL('Unknown',$,$);
#301=IFCMATERIAL('wood1',$,$);
#302=IFCMATERIAL('wood2',$,$);
#310=IFCMATERIALCONSTITUENT('Lining',$,#301,$,$);
#311=IFCMATERIALCONSTITUENT('Framing',$,#301,$,$);
#312=IFCMATERIALCONSTITUENTSET('Unnamed',$,(#310,#311));
#320=IFCMATERIALCONSTITUENT('Lining',$,#302,$,$);
#321=IFCMATERIALCONSTITUENT('Framing',$,#302,$,$);
#322=IFCMATERIALCONSTITUENTSET('Unnamed',$,(#320,#321));
#330=IFCRELASSOCIATESMATERIAL('0RelMat000000000000001',$,$,$,(#100),#300);
#331=IFCRELASSOCIATESMATERIAL('0RelMat000000000000002',$,$,$,(#200),#312);
#332=IFCRELASSOCIATESMATERIAL('0RelMat000000000000003',$,$,$,(#201),#322);`;

describe('buildMaterialUsageIndex end-to-end type expansion (#1755)', () => {
    it('attributes type-associated constituent materials to door occurrences', async () => {
        const { source, entityRefs } = scan(IFC);
        const parser = new ColumnarParser();
        const store = await parser.parseLite(source.buffer.slice(0) as ArrayBuffer, entityRefs, {});

        // Sanity: the parser keyed the associations to the TYPE entities.
        expect(store.onDemandMaterialMap?.get(200)).toBe(312);
        expect(store.onDemandMaterialMap?.get(201)).toBe(322);

        const usage = buildMaterialUsageIndex(store);
        const byName = new Map([...usage.values()].map((u) => [u.name, u]));

        // wood1/wood2 rows must exist and reference the DOOR occurrences.
        expect(byName.get('wood1')!.entries.map((e) => e.entityId)).toEqual([110]);
        expect(byName.get('wood2')!.entries.map((e) => e.entityId)).toEqual([120]);
        // Occurrence-level wall material untouched.
        expect(byName.get('Unknown')!.entries.map((e) => e.entityId)).toEqual([100]);
        // No usage entry may reference a type entity.
        for (const u of usage.values()) {
            for (const e of u.entries) expect([200, 201]).not.toContain(e.entityId);
        }

        // The per-element path (properties panel) keeps its type fallback.
        const info = extractMaterialsOnDemand(store, 110);
        expect(info?.type).toBe('MaterialConstituentSet');
        expect(info?.constituents?.map((c) => c.materialName)).toEqual(['wood1', 'wood1']);
    });
});
