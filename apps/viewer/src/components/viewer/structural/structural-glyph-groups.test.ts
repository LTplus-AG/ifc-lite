/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Glyphs follow their model where the mesh is drawn (#9668): the source
 * frame's offset and the model's placement (Reposition) move and turn them.
 * Expected values are worked out by hand below, not read from the code.
 */

import '@/test/setup-dom.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { IfcParser } from '@ifc-lite/parser';
import type { FederatedModel } from '@/store/types';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { emptyPlacementState } from '@/lib/model-placement/state';
import { structuralGlyphGroups } from './structural-glyph-groups';

const T = 'IFCBOOLEAN(.T.)';
/** Metres. A fixed support at (1, 2, 0) carrying a 3 N force along +X. */
const STEP = `ISO-10303-21;HEADER;FILE_DESCRIPTION((''),'2;1');FILE_NAME('g.ifc','',(''),(''),'','','');FILE_SCHEMA(('IFC4'));ENDSEC;DATA;
#1=IFCPROJECT('0Glyph0000000000000001',$,'P',$,$,$,$,(#3),#2);
#2=IFCUNITASSIGNMENT((#4));
#3=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#9,$);
#4=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#9=IFCAXIS2PLACEMENT3D(#10,$,$);
#10=IFCCARTESIANPOINT((0.,0.,0.));
#11=IFCCARTESIANPOINT((1.,2.,0.));
#12=IFCVERTEXPOINT(#11);
#13=IFCTOPOLOGYREPRESENTATION(#3,'Reference','Vertex',(#12));
#14=IFCPRODUCTDEFINITIONSHAPE($,$,(#13));
#15=IFCBOUNDARYNODECONDITION('fixed',${T},${T},${T},${T},${T},${T});
#16=IFCSTRUCTURALPOINTCONNECTION('0Glyph0000000000000016',$,'N1',$,$,$,#14,#15,$);
#17=IFCSTRUCTURALLOADSINGLEFORCE('P',3.,0.,0.,$,$,$);
#18=IFCSTRUCTURALPOINTACTION('0Glyph0000000000000018',$,'A1',$,$,$,$,#17,.GLOBAL_COORDS.,.F.);
#19=IFCRELCONNECTSSTRUCTURALACTIVITY('0Glyph0000000000000019',$,$,$,#16,#18);
ENDSEC;END-ISO-10303-21;`;

async function seed(placed: boolean) {
  const bytes = new TextEncoder().encode(STEP);
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const store = await new IfcParser().parseColumnar(buffer);
  const coordinateInfo = {
    originShift: { x: 0, y: 0, z: 0 },
    wasmRtcOffset: { x: 0, y: 0, z: 0 },
    shiftedBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 10 } },
  };
  const model = { ...fixtureModel('m'), ifcDataStore: store, geometryResult: { coordinateInfo } } as FederatedModel;
  const placements = new Map(placed ? [['m', { translation: [5, 0, 0] as const, rotation: { angle: Math.PI / 2, pivot: [0, 0, 0] as const }, locked: false }]] : []);
  useViewerStore.setState({ ...fixtureModels(model), modelPlacement: { ...emptyPlacementState(), placements } });
}

const close = (actual: { x: number; y: number; z: number } | null | undefined, expected: [number, number, number]) => {
  assert.ok(actual);
  assert.deepEqual([actual.x, actual.y, actual.z].map((v) => Math.round(v * 1e9) / 1e9 + 0), expected);
};

describe('structuralGlyphGroups', () => {
  it('draws IFC (x, y, z) at render (x, z, -y) for an unplaced model', async () => {
    await seed(false);
    const groups = await structuralGlyphGroups(useViewerStore.getState(), (key) => key);
    const support = groups.find((g) => g.expressId === 16)!;
    close(support.glyphs[0].position, [1, 0, -2]);
    const force = groups.find((g) => g.expressId === 18)!;
    close(force.glyphs[0].direction, [1, 0, 0]);
  });

  it('moves and turns the glyphs with the model placement', async () => {
    // A quarter turn about Z takes IFC (1, 2, 0) to (-2, 1, 0) and +X to +Y;
    // the 5 m move along X then gives (3, 1, 0), drawn at render (3, 0, -1).
    await seed(true);
    const groups = await structuralGlyphGroups(useViewerStore.getState(), (key) => key);
    close(groups.find((g) => g.expressId === 16)!.glyphs[0].position, [3, 0, -1]);
    close(groups.find((g) => g.expressId === 18)!.glyphs[0].direction, [0, 0, -1]);
  });
});
