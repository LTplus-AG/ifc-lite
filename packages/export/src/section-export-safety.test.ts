/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { exportSectionedStep } from './section-export.js';
import { IfcParser } from '@ifc-lite/parser';

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
});
