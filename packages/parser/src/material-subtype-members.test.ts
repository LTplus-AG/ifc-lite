/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { describe, expect, it } from 'vitest';
import { IfcParser, extractAllMaterialsOnDemand, extractMaterialsOnDemand } from './index.js';

const GUID = '3wdauVJT5Fx9drrREiDqA$';

async function parse(rows: string[]) {
    const text = `ISO-10303-21;HEADER;FILE_SCHEMA(('IFC4'));ENDSEC;DATA;\n${rows.join('\n')}\nENDSEC;END-ISO-10303-21;`;
    const bytes = new TextEncoder().encode(text);
    return new IfcParser().parseColumnar(
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
        { disableWorkerScan: true },
    );
}

const COMMON = [
    '#1=IFCMATERIAL(\'Gypsum\',$,\'Board\');',
    '#2=IFCMATERIAL(\'Steel\',$,\'Metal\');',
    `#10=IFCWALL('${GUID}',$,'Wall',$,$,$,$,$,.NOTDEFINED.);`,
    `#11=IFCBEAM('${GUID.replace('3w', '3x')}',$,'Beam',$,$,$,$,$,.NOTDEFINED.);`,
];

describe('material set members that are subtypes of the member entity', () => {
    it('IfcMaterialLayerWithOffsets members keep material, thickness and name', async () => {
        const store = await parse([
            ...COMMON,
            // IfcMaterialLayerWithOffsets is an IFC4 subtype of IfcMaterialLayer (tapered layers).
            '#20=IFCMATERIALLAYERWITHOFFSETS(#1,0.0125,.F.,\'Board\',$,$,$,.AXIS2.,(0.,0.));',
            '#21=IFCMATERIALLAYER(#2,0.1,.F.,\'Stud\',$,$,$);',
            '#22=IFCMATERIALLAYERSET((#20,#21),\'Wall build-up\',$);',
            '#23=IFCRELASSOCIATESMATERIAL(\'' + GUID.replace('3w', '3y') + '\',$,$,$,(#10),#22);',
        ]);
        const info = extractMaterialsOnDemand(store, 10);
        expect(info?.type).toBe('MaterialLayerSet');
        expect(info?.unresolved).toBeUndefined();
        expect(info?.layers?.map((l) => [l.materialName, l.name])).toEqual([['Gypsum', 'Board'], ['Steel', 'Stud']]);
        expect(info?.layers?.[0].thickness).toBeCloseTo(0.0125);
        expect(info?.layers?.[0].materialCategory).toBe('Board');
    });

    it('IfcMaterialProfileWithOffsets members keep material and name', async () => {
        const store = await parse([
            ...COMMON,
            '#30=IFCMATERIALPROFILEWITHOFFSETS(\'Body\',$,#2,$,$,\'Cat\',(0.,0.));',
            '#31=IFCMATERIALPROFILESET(\'Duct\',$,(#30),$);',
            '#32=IFCRELASSOCIATESMATERIAL(\'' + GUID.replace('3w', '3y') + '\',$,$,$,(#11),#31);',
        ]);
        const all = extractAllMaterialsOnDemand(store, 11);
        expect(all[0]?.type).toBe('MaterialProfileSet');
        expect(all[0]?.unresolved).toBeUndefined();
        expect(all[0]?.profiles?.map((p) => [p.materialName, p.name, p.category])).toEqual([['Steel', 'Body', 'Cat']]);
    });
});
