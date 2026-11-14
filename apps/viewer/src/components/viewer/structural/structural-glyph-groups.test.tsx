/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Glyphs follow their model where the mesh is drawn (#9668): the source
 * frame's offset and the model's placement (Reposition) move and turn them.
 * Expected values are worked out by hand below, not read from the code.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { IfcParser } from '@ifc-lite/parser';
import type { FederatedModel } from '@/store/types';
import { cleanup } from '@/test/render.js';
import { act } from 'react';
import { renderScene } from '@/components/viewport-ui/scene/test/scene-test-support.js';
import { Pin } from '@/components/viewport-ui/scene/primitives/Pin.js';
import StructuralGlyphOverlay from './StructuralGlyphOverlay';
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

async function seed(placed: boolean, step = STEP) {
  const bytes = new TextEncoder().encode(step);
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
  useViewerStore.setState({ ...fixtureModels(model), modelPlacement: { ...emptyPlacementState(), placements }, hiddenEntities: new Set(), isolatedEntities: null, hostHiddenIfcTypes: null });
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

  it("drops the glyphs of a class the embed host hides, keeping the others", async () => {
    await seed(false);
    useViewerStore.setState({ hostHiddenIfcTypes: new Set(['ifcstructuralpointaction']) });
    try {
      const groups = await structuralGlyphGroups(useViewerStore.getState(), (key) => key);
      assert.deepEqual(groups.map((g) => g.expressId), [16]);
    } finally {
      useViewerStore.setState({ hostHiddenIfcTypes: null });
    }
  });
});

for (const count of [1, 2]) {
  it(`follows hidden and isolated global ids with ${count} models (#9828)`, async () => {
    await seed(false);
    const state = useViewerStore.getState();
    if (count === 2) {
      const model = state.models.get('m')!;
      useViewerStore.setState({ models: new Map([['m', { ...model, idOffset: 1000 }], ['n', { ...model, id: 'n', idOffset: 2000 }]]) });
    }
    const offset = count === 2 ? 1000 : 0;
    useViewerStore.setState({ hiddenEntities: new Set([offset + 16, offset + 18]) });
    let groups = await structuralGlyphGroups(useViewerStore.getState(), (key) => key);
    assert.equal(groups.filter((g) => g.modelId === 'm').length, 0);
    useViewerStore.setState({ hiddenEntities: new Set(), isolatedEntities: new Set([offset + 18]) });
    groups = await structuralGlyphGroups(useViewerStore.getState(), (key) => key);
    assert.deepEqual(groups.map((g) => [g.modelId, g.expressId]), [['m', 18]]);
  });
}

for (const mode of ['host', 'user', 'isolation'] as const) {
  it(`excludes ${mode}-hidden loads from scale (#9828)`, async () => {
    const extra = `
#24=IFCCARTESIANPOINT((2.,2.,0.));
#25=IFCVERTEXPOINT(#24);
#26=IFCEDGE(#12,#25);
#27=IFCTOPOLOGYREPRESENTATION(#3,'Reference','Edge',(#26));
#28=IFCPRODUCTDEFINITIONSHAPE($,$,(#27));
#20=IFCSTRUCTURALLOADSINGLEFORCE('large',30.,0.,0.,$,$,$);
#21=IFCSTRUCTURALCURVEACTION('0Glyph0000000000000021',$,'large',$,$,$,#28,#20,.GLOBAL_COORDS.,.F.,.CONST.);
#22=IFCSTRUCTURALLOADGROUP('0Glyph0000000000000022',$,'G',$,$,.LOAD_GROUP.,.PERMANENT_G.,.DEAD.,1.,$);
#23=IFCRELASSIGNSTOGROUP('0Glyph0000000000000023',$,$,$,(#18,#21),$,#22);
`;
    // A curve action carrying a single force shares the point-force scale.
    const step = STEP.replace('ENDSEC;END-ISO', extra + 'ENDSEC;END-ISO');
    await seed(false, step);
    let groups = await structuralGlyphGroups(useViewerStore.getState(), (key) => key);
    const relative = () => {
      const glyph = groups.find((g) => g.expressId === 18)!.glyphs[0].glyph;
      return 'relative' in glyph ? glyph.relative : undefined;
    };
    assert.equal(relative(), 0.1);
    if (mode === 'host') useViewerStore.setState({ hostHiddenIfcTypes: new Set(['ifcstructuralcurveaction']) });
    else useViewerStore.setState(mode === 'user' ? { hiddenEntities: new Set([21]) } : { isolatedEntities: new Set([18]) });
    groups = await structuralGlyphGroups(useViewerStore.getState(), (key) => key);
    assert.equal(relative(), 1);
  });
}

afterEach(() => cleanup());
it('exposes named glyphs and Pins while hiding decorative SVG (#9828)', async () => {
  await seed(false);
  const selections: number[] = [];
  const { container, flush } = renderScene(<>
    <StructuralGlyphOverlay onSelect={(_model, id) => selections.push(id)} />
    <Pin worldPoint={{ x: 1, y: 2, z: 0 }} title="Select viewpoint" onClick={() => {}} />
    <Pin worldPoint={{ x: 1, y: 2, z: 0 }} title="Passive" />
  </>);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  flush();
  const buttons = [...container.querySelectorAll('[role="button"]')];
  assert.equal(buttons.length, 3);
  for (const button of buttons) {
    assert.ok(button.getAttribute('aria-label'));
    assert.ok(!button.closest('[aria-hidden="true"]'), 'button must have no hidden ancestor');
    assert.equal(button.getAttribute('tabindex'), '0');
    for (const path of button.querySelectorAll('path')) assert.equal(path.getAttribute('aria-hidden'), 'true');
  }
  const glyph = container.querySelector('[data-express-id="18"]')!;
  act(() => { glyph.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
  assert.deepEqual(selections, [18]);
  assert.equal(container.querySelector('[aria-label="Passive"]'), null);
});

it('honours the effective isolation supplied by viewport and embed (#9828)', async () => {
  await seed(false);
  const groups = await structuralGlyphGroups(useViewerStore.getState(), (key) => key, new Set([18]));
  assert.deepEqual(groups.map((g) => g.expressId), [18]);
});
