/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { existsSync, readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { StepExporter } from './step-exporter.js';
import { mepOccurrences } from '../test/fixtures/mep-occurrences.js';
import { meshMepFixture } from '../test/fixtures/mesh-mep-fixture.js';

const wasmPath = new URL('../../wasm/pkg/ifc-lite_bg.wasm', import.meta.url);
const available = existsSync(wasmPath);
if (!available) console.warn('#8019 real-WASM geometry tests skipped: run scripts/build-wasm.sh.');

describe.skipIf(!available)('MEP downgrade reopens authored geometry (#8019)', () => {
  beforeAll(async () => {
    const { initSync } = await import('@ifc-lite/wasm');
    initSync({ module: readFileSync(wasmPath) });
  });

  it('retains all three authored products and the duct shape through public STEP export', async () => {
    const { IfcAPI } = await import('@ifc-lite/wasm');
    const store = await new IfcParser().parseColumnar(new TextEncoder().encode(mepOccurrences).buffer, { disableWorkerScan: true });
    const output = new StepExporter(store).export({ schema: 'IFC2X3' });
    const text = new TextDecoder().decode(output.content);
    expect(text).toContain("#52=IFCFLOWSEGMENT('0000000000000000000052',#5,'Supply duct','Authored duct','Supply',#35,#25,'duct');");
    expect(text).toContain("#60=IFCDUCTSEGMENTTYPE('0000000000000000000060',#5,'Rigid duct type',$,$,$,$,$,'Supply',.RIGIDSEGMENT.);");
    expect(text).toContain("#61=IFCRELDEFINESBYTYPE('0000000000000000000061',#5,$,$,(#52),#60);");
    expect(text).toContain("#64=IFCRELDEFINESBYPROPERTIES('0000000000000000000064',#5,$,$,(#52),#63);");
    const api = new IfcAPI();
    try {
      const native = new TextDecoder().decode(api.exportStep(new TextEncoder().encode(mepOccurrences), 'IFC2X3', undefined, ''));
      expect(native).toContain("#52=IFCFLOWSEGMENT('0000000000000000000052',#5,'Supply duct','Authored duct','Supply',#35,#25,'duct');");
      for (const source of [mepOccurrences, text, native]) {
        const meshes = meshMepFixture(api, source);
        expect(meshes.map(m => m.expressId).sort((a, b) => a - b)).toEqual([50, 51, 52]);
        expect(meshes).toHaveLength(3);
        for (const [id, x] of [[50, 0], [51, 4], [52, 8]]) {
          const mesh = meshes.find(m => m.expressId === id)!;
          expect(mesh.triangles).toBe(12);
          expect(mesh.volume).toBeCloseTo(6, 6);
          // Canonical batch returns viewer Y-up: IFC (x,y,z) -> (x,z,-y).
          expect(mesh.bounds).toEqual([x - 1, 0, -0.5, x + 1, 3, 0.5]);
        }
      }
    } finally { api.free(); }
  });
});
