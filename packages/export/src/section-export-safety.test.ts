/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { exportSectionedStep } from './section-export.js';
import { IfcParser } from '@ifc-lite/parser';
import { GeometryProcessor } from '@ifc-lite/geometry';

const wasmPath = new URL('../../wasm/pkg/ifc-lite_bg.wasm', import.meta.url);
const available = existsSync(wasmPath);
if (!available) console.warn('Section safety real-WASM tests skipped: run scripts/build-wasm.sh.');
function alignment(representation: string) {
  return new TextEncoder().encode(`ISO-10303-21;
HEADER;FILE_DESCRIPTION(('section safety'),'2;1');FILE_NAME('','',(''),(''),'','','');FILE_SCHEMA(('IFC4X1'));ENDSEC;
DATA;
#1=IFCPROJECT('p',$,'Project',$,$,$,$,(#10),#4);
#2=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);#4=IFCUNITASSIGNMENT((#2));
#10=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#11,$);
#11=IFCAXIS2PLACEMENT3D(#12,$,$);#12=IFCCARTESIANPOINT((0.,0.,0.));
#20=IFCCARTESIANPOINT((10.,0.,0.));#21=IFCCARTESIANPOINT((20.,0.,0.));
#22=IFCPOLYLINE((#20,#21));
#30=IFCSHAPEREPRESENTATION(#10,'Axis','Curve3D',(#22));
#31=IFCPRODUCTDEFINITIONSHAPE($,$,(#30));
#50=IFCALIGNMENT('0M7tQ9Jbj1BAeHd7rqnDmR',$,'Road',$,$,$,${representation},#22);
ENDSEC;END-ISO-10303-21;`);
}
const options = { planes: [{ normal: [1, 0, 0] as const, offset: 0 }], mode: 'trim' as const };
describe.skipIf(!available)('section export excluded alignment safety (#8006)', () => {
  beforeAll(async () => {
    const { initSync } = await import('@ifc-lite/wasm');
    initSync({ module: readFileSync(wasmPath) });
  });
  it('omits a genuinely meshed outside alignment with null Representation', async () => {
    const input = alignment('$');
    const original = input.slice();
    const result = await exportSectionedStep(input, options);
    expect(result.outside).toEqual([50]);
    const output = await new IfcParser().parseColumnar(result.content.slice().buffer as ArrayBuffer, { disableWorkerScan: true });
    expect(output.entityIndex.byId.has(50)).toBe(false);
    expect(input).toEqual(original);
  });
  it('refuses malformed non-null Representation rather than silently detaching it', async () => {
    await expect(exportSectionedStep(alignment("'invalid'"), options)).rejects.toThrow('malformed original Representation');
  });
  it('refuses crossing Axis replacements while retaining whole/inside geometry (#8006)', async () => {
    for (const representation of ['$', '#31']) {
      const input = alignment(representation), original = input.slice();
      const processor = new GeometryProcessor();
      try {
        await processor.init();
        const processed = await processor.process(input);
        expect(processed.meshes.some(mesh => mesh.expressId === 50 && mesh.indices.length > 0)).toBe(true);
      } finally { processor.dispose(); }
      const crossing = { planes: [{normal:[1,0,0] as const,offset:15}] };
      await expect(exportSectionedStep(input, crossing)).rejects.toThrow('cannot trim axis-based alignment #50');
      expect((await exportSectionedStep(input, {...crossing,mode:'whole'})).content).toBe(input);
      expect((await exportSectionedStep(input, {planes:[{normal:[1,0,0],offset:25}]})).content).toBe(input);
      const excluded = await exportSectionedStep(input, options);
      expect(excluded.outside).toEqual([50]);
      const output = await new IfcParser().parseColumnar(excluded.content.slice().buffer as ArrayBuffer, {disableWorkerScan:true});
      expect(output.entityIndex.byId.has(50)).toBe(false);
      expect(input).toEqual(original);
    }
  });
});
