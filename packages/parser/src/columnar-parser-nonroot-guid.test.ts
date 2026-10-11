/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { describe, expect, it } from 'vitest';
import { IfcParser } from './index.js';
import { batchExtractGlobalIdAndName } from './columnar-parser-attributes.js';

const GUID = '3wdauVJT5Fx9drrREiDqA$';
async function parse(bytes: Uint8Array) {
    return new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
        { disableWorkerScan: true });
}

describe('#7276 schema-owned columnar identity', () => {

    for (const comment of [false, true]) for (const name of ['Material', '', null]) {
        it(`material Name ${JSON.stringify(name)} retains schema absence/empty with comment=${comment}`, async () => {
            const token = name === null ? '$' : `'${name}'`;
            const bytes = new TextEncoder().encode(`ISO-10303-21;HEADER;FILE_SCHEMA(('IFC4'));ENDSEC;DATA;
#1=IFCMATERIAL(${comment ? '/* metadata */' : ''}${token},'Description','Category');ENDSEC;END-ISO-10303-21;`);
            const store = await parse(bytes);
            expect(store.getEntity(1)?.attributes[0]).toBe(name);
            expect(store.entities.getGlobalId(1)).toBe('');
            expect(store.entities.getNameOrUndefined(1)).toBe(name ?? undefined);
        });
    }

    it('all existing material metadata helper slots keep Names separate from root identity', async () => {
        const rows = [
            "#1=IFCMATERIAL('Material','Description','Category');",
            "#2=IFCMATERIALLAYER(#1,0.2,.F.,'Layer','Description','Category',0);",
            "#3=IFCMATERIALLAYERSET((#2),'Layer set','Description');",
            "#4=IFCMATERIALLAYERSETUSAGE(#3,.AXIS2.,.POSITIVE.,0.,$);",
            "#5=IFCMATERIALCONSTITUENT('Constituent','Description',#1,1.,'Category');",
            "#6=IFCMATERIALCONSTITUENTSET('Constituent set','Description',(#5));",
            "#7=IFCMATERIALPROFILE('Profile','Description',#1,#9,0,'Category');",
            "#8=IFCMATERIALPROFILESET('Profile set','Description',(#7),$);",
            "#9=IFCRECTANGLEPROFILEDEF(.AREA.,'Rectangle',$,1.,1.);",
        ];
        const bytes = new TextEncoder().encode(`ISO-10303-21;HEADER;FILE_SCHEMA(('IFC4'));ENDSEC;DATA;${rows.join('')}ENDSEC;END-ISO-10303-21;`);
        const store = await parse(bytes);
        // IfcMaterialLayerSet declares LayerSetName, not Name; usage declares neither.
        expect(store.getEntity(3)?.attributes[1]).toBe('Layer set');
        const expected = ['Material', 'Layer', undefined, undefined, 'Constituent', 'Constituent set', 'Profile', 'Profile set'];
        for (let id = 1; id <= expected.length; id++) {
            expect(store.getEntity(id)).not.toBeNull();
            expect(store.entities.getGlobalId(id)).toBe('');
            expect(store.entities.getNameOrUndefined(id)).toBe(expected[id - 1]);
        }
    });

    it('known non-root classification uses declared Name while unknown vendor batch policy remains explicit', async () => {
        const bytes = new TextEncoder().encode(`ISO-10303-21;HEADER;FILE_SCHEMA(('IFC4'));ENDSEC;DATA;
#1=IFCCLASSIFICATION('Source','Edition',$,/* label */'Actual classification',$,$,$);
#2=IFCVENDORROOT('${GUID}',$,'Vendor name');ENDSEC;END-ISO-10303-21;`);
        const store = await parse(bytes);
        const refs = [store.entityIndex.byId.get(1)!, store.entityIndex.byId.get(2)!];
        expect(store.getEntity(1)?.attributes[3]).toBe('Actual classification');
        const rows = await batchExtractGlobalIdAndName(bytes, refs);
        expect(rows.get(1)).toEqual({ globalId: '', name: 'Actual classification' });
        expect(rows.get(2)).toEqual({ globalId: GUID, name: 'Vendor name' });
    });
});
