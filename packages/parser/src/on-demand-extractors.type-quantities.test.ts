/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #3722 asked for a fixture that actually drives `extractTypeQuantitiesOnDemand`
 * (not just its `setIdentityKey`/`appendSetsFromSecondSource` helpers, already
 * covered directly by `property-set-merge.test.ts`) over a type carrying a
 * `Qto_X` reachable via `HasPropertySets` AND a distinct `Qto_X` reachable via
 * IFC4 `IfcRelDefinesByProperties`. Before the fix, `appendSetsFromSecondSource`
 * deduped by name alone and the second source's Qto_X vanished; this exercises
 * the full path -- byte scan, columnar parse, on-demand quantity map, and the
 * extractor itself -- so a regression in how those pieces are WIRED together
 * (not just in the helper) turns this red.
 *
 * Three scenarios, each its own IfcWallType + IfcWall + IfcRelDefinesByType,
 * so they cannot interfere with one another's on-demand maps:
 *
 *  - Scenario 1 (#1xxx): two DISTINCT `IfcElementQuantity` instances, same
 *    name "Qto_X", different GlobalId -- one via HasPropertySets, one via
 *    IfcRelDefinesByProperties. Both must survive.
 *  - Scenario 2 (#2xxx): the SAME (name, GlobalId) reachable through both
 *    paths under two different express ids (a malformed/duplicated export).
 *    Must still collapse to one -- the first-source ("HasPropertySets") copy.
 *  - Scenario 3 (#3xxx): neither instance declares a GlobalId (name-only
 *    fallback, which the issue requires explicitly). Same name, no identity
 *    to key on -- must still collapse to one.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { StepTokenizer } from './tokenizer.js';
import { ColumnarParser } from './columnar-parser.js';
import { extractTypeQuantitiesOnDemand } from './on-demand-extractors.js';
import type { IfcDataStore } from './columnar-parser.js';

// prettier-ignore
const IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('type quantity dedup fixture (#3722)'),'2;1');
FILE_NAME('type_quantity_dedup.ifc','2026-09-03T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0Project000000000000AA',$,'P',$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#5,$);
#3=IFCUNITASSIGNMENT((#6));
#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);
#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#7=IFCLOCALPLACEMENT($,#5);

/* Scenario 1: distinct GlobalIds, same name -- both must survive. */
#1010=IFCWALLTYPE('TYPE1-GUID000000000A',$,'WT-Scenario1',$,$,(#1100),$,$,$,.NOTDEFINED.);
#1100=IFCELEMENTQUANTITY('GID-A-00000000000001',$,'Qto_X',$,$,(#1101));
#1101=IFCQUANTITYLENGTH('Length',$,$,5.0);
#1110=IFCELEMENTQUANTITY('GID-B-00000000000001',$,'Qto_X',$,$,(#1111));
#1111=IFCQUANTITYLENGTH('Length',$,$,7.0);
#1120=IFCRELDEFINESBYPROPERTIES('REL1-GUID00000000000A',$,$,$,(#1010),#1110);
#1200=IFCWALL('ELEM1-GUID0000000000A',$,'W-Scenario1',$,$,#7,$,$,.NOTDEFINED.);
#1210=IFCRELDEFINESBYTYPE('RELT1-GUID000000000A',$,$,$,(#1200),#1010);

/* Scenario 2: SAME (name, GlobalId), different express ids -- must collapse
   to one, keeping the HasPropertySets (first-source) copy (Length=9). */
#2010=IFCWALLTYPE('TYPE2-GUID000000000A',$,'WT-Scenario2',$,$,(#2100),$,$,$,.NOTDEFINED.);
#2100=IFCELEMENTQUANTITY('GID-C-00000000000002',$,'Qto_Z',$,$,(#2101));
#2101=IFCQUANTITYLENGTH('Length',$,$,9.0);
#2110=IFCELEMENTQUANTITY('GID-C-00000000000002',$,'Qto_Z',$,$,(#2111));
#2111=IFCQUANTITYLENGTH('Length',$,$,99.0);
#2120=IFCRELDEFINESBYPROPERTIES('REL2-GUID00000000000A',$,$,$,(#2010),#2110);
#2200=IFCWALL('ELEM2-GUID0000000000A',$,'W-Scenario2',$,$,#7,$,$,.NOTDEFINED.);
#2210=IFCRELDEFINESBYTYPE('RELT2-GUID000000000A',$,$,$,(#2200),#2010);

/* Scenario 3: neither instance declares a GlobalId -- name-only fallback
   must still collapse to one, keeping the HasPropertySets copy (Length=3). */
#3010=IFCWALLTYPE('TYPE3-GUID000000000A',$,'WT-Scenario3',$,$,(#3100),$,$,$,.NOTDEFINED.);
#3100=IFCELEMENTQUANTITY($,$,'Qto_W',$,$,(#3101));
#3101=IFCQUANTITYLENGTH('Length',$,$,3.0);
#3110=IFCELEMENTQUANTITY($,$,'Qto_W',$,$,(#3111));
#3111=IFCQUANTITYLENGTH('Length',$,$,33.0);
#3120=IFCRELDEFINESBYPROPERTIES('REL3-GUID00000000000A',$,$,$,(#3010),#3110);
#3200=IFCWALL('ELEM3-GUID0000000000A',$,'W-Scenario3',$,$,#7,$,$,.NOTDEFINED.);
#3210=IFCRELDEFINESBYTYPE('RELT3-GUID000000000A',$,$,$,(#3200),#3010);
ENDSEC;
END-ISO-10303-21;
`;

describe('extractTypeQuantitiesOnDemand: HasPropertySets + IfcRelDefinesByProperties dedup (#3722)', () => {
    let store: IfcDataStore;

    beforeAll(async () => {
        const source = new TextEncoder().encode(IFC);
        const tokenizer = new StepTokenizer(source);
        const entityRefs: Array<{
            expressId: number;
            type: string;
            byteOffset: number;
            byteLength: number;
            lineNumber: number;
        }> = [];
        for (const ref of tokenizer.scanEntitiesFast()) {
            entityRefs.push({
                expressId: ref.expressId,
                type: ref.type,
                byteOffset: ref.offset,
                byteLength: ref.length,
                lineNumber: ref.line,
            });
        }
        const parser = new ColumnarParser();
        store = await parser.parseLite(source.buffer.slice(0), entityRefs, {});
    });

    it('keeps two distinct same-named type quantity sets separate (different GlobalId)', () => {
        const result = extractTypeQuantitiesOnDemand(store, 1200);
        expect(result).not.toBeNull();
        const qtoXSets = result!.quantities.filter((q) => q.name === 'Qto_X');
        expect(qtoXSets).toHaveLength(2);
        expect(qtoXSets.map((q) => q.globalId).sort()).toEqual(
            ['GID-A-00000000000001', 'GID-B-00000000000001'].sort(),
        );
        const lengths = qtoXSets
            .map((q) => q.quantities.find((c) => c.name === 'Length')?.value)
            .sort((a, b) => (a ?? 0) - (b ?? 0));
        expect(lengths).toEqual([5.0, 7.0]);
    });

    it('collapses two rows of the SAME (name, GlobalId) instance to one', () => {
        const result = extractTypeQuantitiesOnDemand(store, 2200);
        expect(result).not.toBeNull();
        const qtoZSets = result!.quantities.filter((q) => q.name === 'Qto_Z');
        expect(qtoZSets).toHaveLength(1);
        expect(qtoZSets[0].globalId).toBe('GID-C-00000000000002');
        // The surviving row is the HasPropertySets (first-source) one.
        expect(qtoZSets[0].quantities.find((c) => c.name === 'Length')?.value).toBe(9.0);
    });

    it('falls back to name-only dedup when neither instance declares a GlobalId', () => {
        const result = extractTypeQuantitiesOnDemand(store, 3200);
        expect(result).not.toBeNull();
        const qtoWSets = result!.quantities.filter((q) => q.name === 'Qto_W');
        expect(qtoWSets).toHaveLength(1);
        expect(qtoWSets[0].globalId).toBeUndefined();
        expect(qtoWSets[0].quantities.find((c) => c.name === 'Length')?.value).toBe(3.0);
    });
});
