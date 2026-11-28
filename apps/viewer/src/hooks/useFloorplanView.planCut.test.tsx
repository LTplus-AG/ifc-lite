/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Floor plan above the model top (#8162). `activateFloorplan` used to clamp
 * floor + 1.2 m to the merged Y range, so a top storey whose cut clears the
 * model top was cut on the top face instead. It now stores a position past
 * 100 % that resolves to floor + 1.2 m, while a floor outside the range keeps
 * the clamped fallback. The store keeps a percentage, so a later bounds change
 * moves the cut the way it moves any percentage cut, and activating the floor
 * plan again recomputes floor + 1.2 m against the new bounds.
 */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { IfcParser } from '@ifc-lite/parser';
import type { GeometryResult } from '@ifc-lite/geometry';
import { render, click, cleanup } from '@/test/render.js';
import { useViewerStore, type FederatedModel } from '@/store';
import { fixtureModel } from '@/test/store-fixture.js';
import type { SectionStorey } from '@/lib/section/section-distance';
import { emptyPlacementState } from '@/lib/model-placement/state';
import { useSectionDistance } from '@/components/viewer/tools/useSectionDistance';
import { Renderer } from '@ifc-lite/renderer';
import { appearanceInstanceScene } from '@/test/appearance-instance-scene';
import { getGlobalRenderer, setGlobalRendererRef } from './useBCF.js';
import { modelIndices } from '@/lib/model-placement/model-indices';
import { publishPlacementBounds } from '@/lib/model-placement/bounds-revision';
import { SectionActivePlaneRow } from '@/components/viewer/tools/SectionActivePlaneRow';
import { HudPopover } from '@/components/viewport-ui/hud';

import { StoreyFloorplanButton } from '@/components/viewer/hierarchy/StoreyDisplayControls';
import { useFloorplanView } from './useFloorplanView.js';

function bounded(id: string, maxY: number): FederatedModel {
  const box = { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: maxY, z: 8 } };
  const geometryResult: GeometryResult = {
    meshes: [], totalVertices: 0, totalTriangles: 0,
    coordinateInfo: { originShift: { x: 0, y: 0, z: 0 }, originalBounds: box, shiftedBounds: box, hasLargeCoordinates: false },
  };
  return { ...fixtureModel(id), geometryResult };
}

let storeys: SectionStorey[] = [];
let activate: ((storey: SectionStorey) => void) | null = null;
let menuElevation: number | undefined;
function Probe(): null {
  menuElevation = useSectionDistance().storeys.find((entry) => entry.expressId === 5)?.displayElevation;
  const floorplan = useFloorplanView();
  activate = floorplan.activateFloorplan;
  storeys = floorplan.availableStoreys;
  return null;
}

const s = () => useViewerStore.getState();
const top: SectionStorey = { expressId: 11, modelId: 'a', name: 'Top', elevation: 2.5 };
/** The stored cut resolved against a [0, maxY] Y range, the way the renderer and drawing read it. */
const cutY = (maxY: number) => (s().sectionPlane.position / 100) * maxY;

function load(...models: FederatedModel[]): void {
  act(() => useViewerStore.setState({ models: new Map(models.map((m) => [m.id, m])), geometryResult: null, ifcDataStore: null }));
}

beforeEach(() => {
  useViewerStore.setState({
    activeTool: 'select', activeStorey: null, drawing2DPanelVisible: false, modelPlacement: emptyPlacementState(),
    sectionPlane: { ...s().sectionPlane, axis: 'front', position: 10, enabled: false, parked: false, custom: undefined },
  });
  load(bounded('a', 3));
  render(<Probe />);
  assert.ok(activate, 'the hook returned activateFloorplan');
});
afterEach(() => { cleanup(); activate = null; });

it('a top storey at 2.5 m under a 3 m model top cuts at 3.7 m (> 100 %), not on the top face', () => {
  act(() => activate!(top));
  assert.equal(s().sectionPlane.axis, 'down');
  assert.ok(s().sectionPlane.position > 100, `position ${s().sectionPlane.position} must exceed 100`);
  assert.ok(Math.abs(cutY(3) - 3.7) < 1e-9, `the cut resolves to ${cutY(3)} m, not 3.7 m`);
});

it('an in-range storey is unchanged, and a floor outside the range keeps the clamped fallback', () => {
  act(() => activate!({ ...top, elevation: 0 }));
  assert.ok(Math.abs(s().sectionPlane.position - 40) < 1e-9, 'floor 0 + 1.2 m is 40 % of [0, 3]');
  act(() => activate!({ ...top, elevation: 10 }));
  assert.equal(s().sectionPlane.position, 100, 'a floor above the range clamps');
  act(() => activate!({ ...top, elevation: -4 }));
  assert.equal(s().sectionPlane.position, 0, 'a floor below the range clamps');
});

it('a federated bounds change keeps the percentage, and re-activating recomputes floor + 1.2 m', () => {
  act(() => activate!(top));
  const stored = s().sectionPlane.position;
  // A second model raises the merged top to 6 m: like every percentage cut,
  // the stored position is unchanged (fixing world anchoring across bounds
  // changes is out of scope for #8162), so it now resolves elsewhere.
  load(bounded('a', 3), bounded('b', 6));
  assert.equal(s().sectionPlane.position, stored, 'a bounds change does not rewrite the stored position');
  act(() => activate!(top));
  assert.ok(Math.abs(cutY(6) - 3.7) < 1e-9, `re-activating cuts at 3.7 m of the new [0, 6] range, got ${cutY(6)}`);
  assert.ok(s().sectionPlane.position < 100, 'now inside the range');
  // And back: hiding the taller model brings the top back to 3 m; re-activating extrapolates again.
  load(bounded('a', 3), { ...bounded('b', 6), visible: false });
  act(() => activate!(top));
  assert.ok(Math.abs(cutY(3) - 3.7) < 1e-9, `got ${cutY(3)}`);
});


// IFC millimetres: the building is at 100 m and the floor is 3 m above it.
// The authored Elevation variants all describe the same placement.
const placedStorey = (elevation: string, placement = '#14') => `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0Proj00000000000000001',$,'Project',$,$,$,$,$,#3);
#2=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);
#3=IFCUNITASSIGNMENT((#2));
#4=IFCBUILDING('0Bldg00000000000000001',$,'Building',$,$,#11,$,$,.ELEMENT.,$,$,$);
#5=IFCBUILDINGSTOREY('0Story0000000000000001',$,'Level 1',$,$,${placement},$,$,.ELEMENT.,${elevation});
#6=IFCRELAGGREGATES('0Rels00000000000000001',$,$,$,#1,(#4));
#7=IFCRELAGGREGATES('0Rels00000000000000002',$,$,$,#4,(#5));
#11=IFCLOCALPLACEMENT($,#12);
#12=IFCAXIS2PLACEMENT3D(#13,$,$);
#13=IFCCARTESIANPOINT((0.,0.,100000.));
#14=IFCLOCALPLACEMENT(#11,#15);
#15=IFCAXIS2PLACEMENT3D(#16,$,$);
#16=IFCCARTESIANPOINT((0.,0.,3000.));
ENDSEC;
END-ISO-10303-21;`;

for (const [kind, elevation, placement] of [
  ['relative', '3000.', '#14'],
  ['absolute', '103000.', '#14'],
  ['omitted', '$', '#14'],
  ['absolute without a usable placement', '103000.', '$'],
]) {
  it(`#11459 synthetic IFC: ${kind} Elevation cuts 1.2 m above the floor in the placed render frame`, async () => {
    const bytes = new TextEncoder().encode(placedStorey(elevation, placement));
    const ifcDataStore = await new IfcParser().parseColumnar(bytes.buffer as ArrayBuffer, { disableWorkerScan: true });
    const model = bounded('a', 8);
    const geometryResult = model.geometryResult!;
    // 103 m world floor minus 90 m RTC and 10 m origin shift => 3 m
    // before the workspace moves the model up another 2 m.
    geometryResult.coordinateInfo.wasmRtcOffset = { x: 0, y: 0, z: 90 };
    geometryResult.coordinateInfo.originShift = { x: 0, y: 10, z: 0 };
    load({ ...model, ifcDataStore });
    const state = emptyPlacementState();
    act(() => useViewerStore.setState({
      modelPlacement: {
        ...state,
        placements: new Map([['a', { translation: [0, 0, 2], rotation: { angle: 0, pivot: [0, 0, 0] }, locked: false }]]),
      },
    }));
    const storey = storeys.find((entry) => entry.expressId === 5);
    assert.ok(storey);
    assert.equal(menuElevation, 103);
    act(() => activate!(storey));
    // The moved range is [2, 10], so the 6.2 m cut is at 52.5%.
    assert.ok(Math.abs(s().sectionPlane.position - 52.5) < 1e-9, `cut at ${s().sectionPlane.position}%`);
  });
}

const parseStoreys = (step: string) => new IfcParser().parseColumnar(
  new TextEncoder().encode(step).buffer as ArrayBuffer, { disableWorkerScan: true },
);
const groundStorey = placedStorey('0.').replace('100000.', '0.').replace('((0.,0.,3000.))', '((0.,0.,0.))');

function openStoreyMenu(ui: HTMLElement): void {
  act(() => s().setSectionPlaneAxis('down'));

  click(ui.querySelector('button[aria-label="Cut at a storey"]')!);
}

function storeyRows(name: string): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>('button')].filter(
    button => button.textContent?.trim().startsWith(name),
  );
}

function cutFromPlan(ui: HTMLElement, modelId: string, expressId: number): void {
  act(() => useViewerStore.setState({ activeStorey: { modelId, expressId } }));
  const button = ui.querySelector<HTMLButtonElement>('button[aria-label="Floorplan the active storey"]');
  assert.ok(button && !button.disabled, 'floor plan is available for the active storey');
  click(button);
}

const sharedPlacementStoreys = groundStorey.replace('(#5));', '(#5,#8));')
  .replace('#11=IFCLOCALPLACEMENT', "#8=IFCBUILDINGSTOREY('0Story0000000000000002',$,'Level 2',$,$,#14,$,$,.ELEMENT.,3000.);\n#11=IFCLOCALPLACEMENT");

const scaledSharedPlacementStoreys = sharedPlacementStoreys
  .replace("'IFC4'", "'IFC4X3_ADD2'")
  .replace('.MILLI.,.METRE.', '$,.METRE.')
  .replace('.ELEMENT.,3000.);', '.ELEMENT.,3.);')
  .replace("$,$,$,$,#3);", "$,$,$,(#20),#3);")
  .replace('ENDSEC;\nEND-ISO', `#20=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#12,$);
#21=IFCPROJECTEDCRS('EPSG:2056',$,$,$,$,$,#2);
#22=IFCMAPCONVERSIONSCALED(#20,#21,2600000.,1200000.,400.,1.,0.,1.,1.,1.,2.);
ENDSEC;
END-ISO`);

for (const [kind, step, lowerHeight, upperHeight] of [
  ['engineering', sharedPlacementStoreys, '0.00 m', '3.00 m'],
  ['projected with FactorZ=2', scaledSharedPlacementStoreys, '400.00 m', '406.00 m'],
] as const) {
  it(`#11459 shared placement keeps both ${kind} labels and physical cuts`, async () => {
    load({ ...bounded('a', 8), ifcDataStore: await parseStoreys(step) });
    const ui = render(<><HudPopover><SectionActivePlaneRow /></HudPopover><StoreyFloorplanButton /></>);
    openStoreyMenu(ui);
    assert.equal(storeyRows('Level 1')[0]?.lastElementChild?.textContent, lowerHeight);
    assert.equal(storeyRows('Level 2')[0]?.lastElementChild?.textContent, upperHeight);
    for (const [name, id, cut] of [['Level 1', 5, 1.2], ['Level 2', 8, 4.2]] as const) {
      click(storeyRows(name)[0]);
      assert.ok(Math.abs(cutY(8) - cut) < 1e-9);
      cutFromPlan(ui, 'a', id);
      assert.ok(Math.abs(cutY(8) - cut) < 1e-9);
    }
  });
}

it('#11459 both storey controls use the placed federation bounds before and after renderer sync', async () => {
  const data = await parseStoreys(groundStorey);
  load({ ...bounded('a', 8), ifcDataStore: data }, { ...bounded('b', 8), ifcDataStore: data });
  act(() => useViewerStore.setState({
    modelPlacement: {
      ...emptyPlacementState(),
      placements: new Map([['b', { translation: [0, 0, 20], rotation: { angle: 0, pivot: [0, 0, 0] }, locked: false }]]),
    },
  }));
  const ui = render(<><HudPopover><SectionActivePlaneRow /></HudPopover><StoreyFloorplanButton /></>);
  const checkCuts = () => {
    if (!storeyRows('Level 1').length) openStoreyMenu(ui);
    const rows = storeyRows('Level 1');
    assert.equal(rows.length, 2);
    click(rows[0]);
    const toolbar = cutY(28).toFixed(3);
    cutFromPlan(ui, 'b', 5);
    assert.deepEqual({ toolbar, floorPlan: cutY(28).toFixed(3) }, { toolbar: '21.200', floorPlan: '21.200' });
  };
  // Producer bounds suffice before any upload. Then upload both meshes in their
  // source frame to exercise the interval before workspace placement sync.
  checkCuts();
  const previous = getGlobalRenderer();
  const renderer = new Renderer(document.createElement('canvas'));
  const { device, pipeline } = appearanceInstanceScene([]);
  const indices = modelIndices(s().models);
  const mesh = (modelId: string, expressId: number) => ({
    expressId, modelIndex: indices.get(modelId), positions: new Float32Array([0, 0, 0, 10, 0, 0, 0, 8, 8]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), indices: new Uint32Array([0, 1, 2]),
    color: [1, 1, 1, 1] as [number, number, number, number],
  });
  renderer.getScene().appendToBatches([mesh('a', 11), mesh('b', 12)], device, pipeline, false);
  try {
    act(() => { setGlobalRendererRef({ current: renderer }); publishPlacementBounds(); });
    checkCuts();
    act(() => { renderer.setModelTranslation(indices.get('b')!, [0, 20, 0]); publishPlacementBounds(); });
    checkCuts();
  } finally {
    setGlobalRendererRef({ current: previous });
  }
});
