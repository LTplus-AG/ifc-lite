/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #6233: the Add Element tool's preview and commit disagreed.
 *
 *  - The hover ghost sat on whatever the raycast hit (a slab top, a wall
 *    face) while the commit clamped to the storey floor, so the ghost floated
 *    where nothing would land, and a window's sill landed on the floor.
 *  - The storey was chosen three different ways: the empty-space fallback
 *    raycast used the panel storey, smart placement took the clicked
 *    element's storey, a two-click element took it from the SECOND click
 *    only, and the polygon commit ignored inference.
 *  - The pick → builder conversion only undid the model's reposition. The
 *    builders anchor to the storey's placement, so on a storey that does not
 *    sit at the model origin (the demo's hangs 3 m east, 3 m north) every
 *    element was written a whole storey offset away from the click.
 *
 * The fixture is a real parsed model shaped like the demo: the building is
 * placed at (3, 3) under the site, storey A at its origin (elevation 0) and
 * storey B at elevation 3, turned 90° (RefDirection (0,1,0)). A proxy #300 is
 * contained in storey B so a click on it infers B.
 */

import '@/test/setup-dom.js';
import { describe, it, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { useViewerStore } from '@/store';
import type { FederatedModel } from '@/store/types';
import type { AddElementVec3 } from '@/store/slices/addElementSlice';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { handleSelectionClick } from './selectionHandlers.js';
import { commitAddElementSlabPolygon, handleAddElementHover } from './add-element-handlers.js';
import { withAddElementWorkplane } from './add-element-workplane.js';
import type { MouseHandlerContext } from './mouseHandlerTypes.js';
import { authoredElementMeshPayload } from '@/store/slices/authoredElement';
import { storeyAuthoringFrame } from '@/lib/authoring/storey-authoring-frame';

const MODEL = 'demo-like';
const STOREY_A = 4;
const STOREY_B = 5;
const PROXY_ON_B = 300;

const IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0PROJECT000000000000',$,'Proj',$,$,$,$,(#7),#8);
#7=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#9,$);
#9=IFCAXIS2PLACEMENT3D(#90,$,$);
#90=IFCCARTESIANPOINT((0.,0.,0.));
#8=IFCUNITASSIGNMENT((#81));
#81=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#2=IFCSITE('0SITE0000000000000000',$,'Site',$,$,#11,$,$,.ELEMENT.,$,$,$,$,$);
#11=IFCLOCALPLACEMENT($,#12);
#12=IFCAXIS2PLACEMENT3D(#91,$,$);
#91=IFCCARTESIANPOINT((0.,0.,0.));
#3=IFCBUILDING('0BUILDING000000000000',$,'Bldg',$,$,#13,$,$,.ELEMENT.,$,$,$);
#13=IFCLOCALPLACEMENT(#11,#14);
#14=IFCAXIS2PLACEMENT3D(#92,$,$);
#92=IFCCARTESIANPOINT((3.,3.,0.));
#4=IFCBUILDINGSTOREY('0STOREYA0000000000000',$,'A',$,$,#15,$,$,.ELEMENT.,0.);
#15=IFCLOCALPLACEMENT(#13,#16);
#16=IFCAXIS2PLACEMENT3D(#93,$,$);
#93=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCBUILDINGSTOREY('0STOREYB0000000000000',$,'B',$,$,#17,$,$,.ELEMENT.,3.);
#17=IFCLOCALPLACEMENT(#13,#18);
#18=IFCAXIS2PLACEMENT3D(#94,$,#95);
#94=IFCCARTESIANPOINT((0.,0.,3.));
#95=IFCDIRECTION((0.,1.,0.));
#300=IFCBUILDINGELEMENTPROXY('0PROXY000000000000000',$,'On B',$,$,$,$,$,$);
#70=IFCRELAGGREGATES('0RELAGG0000000000000',$,$,$,#1,(#2));
#71=IFCRELAGGREGATES('0RELAGG0000000000001',$,$,$,#2,(#3));
#72=IFCRELAGGREGATES('0RELAGG0000000000002',$,$,$,#3,(#4,#5));
#73=IFCRELCONTAINEDINSPATIALSTRUCTURE('0RELCONT000000000000',$,$,$,(#300),#5);
ENDSEC;
END-ISO-10303-21;
`;

let parsed: IfcDataStore;
before(async () => {
  parsed = await new IfcParser().parseColumnar(new TextEncoder().encode(IFC).buffer);
});

type Hit = { point: AddElementVec3; expressId: number | null } | null;
type Calls = Array<{ action: string; storeyId: number; params: Record<string, unknown> }>;

let calls: Calls;
let hits: Hit[];
let original: ReturnType<typeof useViewerStore.getState>;
const originalRaf = globalThis.requestAnimationFrame;

/** A camera looking straight down from y = 50, one CSS pixel = one metre. */
function makeCtx(): MouseHandlerContext {
  const canvas = document.createElement('canvas');
  canvas.width = 100; canvas.height = 100;
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100 }) as DOMRect;
  return {
    canvas,
    renderer: {
      raycastSceneMagnetic: () => {
        const hit = hits.shift() ?? null;
        return {
          intersection: hit ? { point: hit.point, expressId: hit.expressId } : null,
          snapTarget: null,
          edgeLock: { shouldRelease: false, shouldLock: false },
        };
      },
      getCamera: () => ({
        unprojectToRay: (sx: number, sy: number) => ({ origin: { x: sx, y: 50, z: sy }, direction: { x: 0, y: -1, z: 0 } }),
      }),
      getCanvas: () => canvas,
      requestRender: () => {},
    },
    mouseState: { isDragging: false, isPanning: false, lastX: 0, lastY: 0, button: 0, startX: 0, startY: 0, didDrag: false },
    activeToolRef: { current: 'addElement' },
    edgeLockStateRef: { current: { edge: null, meshExpressId: null, lockStrength: 0 } },
    snapEnabledRef: { current: false },
    hiddenEntitiesRef: { current: new Set<number>() },
    isolatedEntitiesRef: { current: null },
    measureRaycastPendingRef: { current: false },
    measureRaycastFrameRef: { current: null },
    setSnapTarget: () => {},
    clearEdgeLock: () => {},
    setEdgeLock: () => {},
  } as unknown as MouseHandlerContext;
}

/** Click at CSS (x, y): the fake camera maps that to renderer (x, ·, y). */
async function click(ctx: MouseHandlerContext, x: number, y: number): Promise<void> {
  await handleSelectionClick(ctx, { clientX: x, clientY: y } as MouseEvent);
}

function recorder(action: string) {
  return (_modelId: string, storeyId: number, params: unknown) => {
    calls.push({ action, storeyId, params: params as Record<string, unknown> });
    return { expressId: 900 + calls.length };
  };
}

function near(actual: readonly number[], expected: readonly number[], what: string): void {
  assert.equal(actual.length, expected.length, `${what}: length`);
  actual.forEach((v, i) => assert.ok(Math.abs(v - expected[i]) < 1e-9, `${what}[${i}]: got ${v}, expected ${expected[i]}`));
}

beforeEach(() => {
  original = useViewerStore.getState();
  calls = [];
  hits = [];
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => { cb(0); return 1; }) as typeof requestAnimationFrame;
  const model = fixtureModel(MODEL) as FederatedModel & { ifcDataStore: IfcDataStore };
  model.ifcDataStore = parsed;
  useViewerStore.setState({
    ...fixtureModels(model),
    mutationViews: new Map(),
    activeTool: 'addElement',
    addElementType: 'beam', // two-click axial; walls are the wall.place command (#6232)
    addElementModelId: MODEL,
    addElementStoreyId: STOREY_A,
    addElementSlabMode: 'rectangle',
    addElementPendingPoints: [],
    addElementHoverPoint: null,
    addElementHoverSnapPoint: null,
    addElementGestureStorey: null,
    addBeam: recorder('addBeam'),
    addWindow: recorder('addWindow'),
    addSlab: recorder('addSlab'),
    setSelectedEntityId: () => {},
  } as Partial<ReturnType<typeof useViewerStore.getState>>);
});

afterEach(() => {
  globalThis.requestAnimationFrame = originalRaf;
  useViewerStore.setState(original, true);
});

describe('Add Element workplane: one storey per gesture (#6233)', () => {
  it('locks the storey at the FIRST click: a beam started on B commits on B even when the second click is in empty space', async () => {
    const ctx = makeCtx();
    hits = [{ point: { x: 5, y: 4.2, z: -4 }, expressId: PROXY_ON_B }, null];
    await click(ctx, 5, -4);
    assert.deepEqual(useViewerStore.getState().addElementGestureStorey, { modelId: MODEL, storeyId: STOREY_B });
    await click(ctx, 5, -8);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].storeyId, STOREY_B, 'panel says A; the gesture was locked to B by its first click');
    assert.equal(useViewerStore.getState().addElementGestureStorey, null, 'the lock ends with the gesture');
  });

  it("the empty-space fallback raycast uses the locked storey's floor, not the panel's", async () => {
    const ctx = makeCtx();
    hits = [{ point: { x: 5, y: 4.2, z: -4 }, expressId: PROXY_ON_B }, null];
    await click(ctx, 5, -4);
    handleAddElementHover(ctx, 7, -6);
    const hover = useViewerStore.getState().addElementHoverPoint;
    assert.ok(hover, 'the miss still lands on a floor');
    assert.equal(hover.y, 3, "storey B's floor, where the commit will put the element");
  });

  it('the polygon commit uses the storey its first point locked', async () => {
    useViewerStore.setState({ addElementType: 'slab', addElementSlabMode: 'polygon' });
    const ctx = makeCtx();
    hits = [{ point: { x: 4, y: 3.5, z: -4 }, expressId: PROXY_ON_B }, null, null];
    await click(ctx, 4, -4);
    await click(ctx, 8, -4);
    await click(ctx, 8, -9);
    commitAddElementSlabPolygon();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].storeyId, STOREY_B);
  });
});

describe('Add Element workplane: the ghost is the commit (#6233)', () => {
  it('hover projects a raised snap onto the workplane and remembers the raw point for the drop line', () => {
    const ctx = makeCtx();
    hits = [{ point: { x: 6, y: 1.8, z: -5 }, expressId: null }];
    handleAddElementHover(ctx, 6, -5);
    const s = useViewerStore.getState();
    assert.deepEqual(s.addElementHoverPoint, { x: 6, y: 0, z: -5 }, "storey A's floor, not the surface under the cursor");
    assert.deepEqual(s.addElementHoverSnapPoint, { x: 6, y: 1.8, z: -5 });
  });

  it('a click at the hovered spot stores exactly the previewed point', async () => {
    const ctx = makeCtx();
    hits = [{ point: { x: 6, y: 1.8, z: -5 }, expressId: null }, { point: { x: 6, y: 1.8, z: -5 }, expressId: null }];
    handleAddElementHover(ctx, 6, -5);
    const previewed = useViewerStore.getState().addElementHoverPoint;
    await click(ctx, 6, -5);
    assert.deepEqual(useViewerStore.getState().addElementPendingPoints, [previewed]);
  });

  it('a window lands with its sill at the Sill height parameter, not on the floor', async () => {
    useViewerStore.setState({ addElementType: 'window' });
    useViewerStore.getState().setAddElementWindowParams({ SillHeight: 0.9 });
    hits = [{ point: { x: 5, y: 1.2, z: -4 }, expressId: null }];
    await click(makeCtx(), 5, -4);
    assert.equal(calls[0].action, 'addWindow');
    assert.equal((calls[0].params.Position as number[])[2], 0.9);
  });
});

describe('Add Element workplane: storey-local means storey-local (#6233)', () => {
  it("divides the storey's XY offset out: a beam clicked at model (5,4)→(9,4) is written at (2,1)→(6,1) on storey A at (3,3)", async () => {
    const ctx = makeCtx();
    hits = [null, null];
    await click(ctx, 5, -4); // renderer (5, ·, -4) = model (5, 4)
    await click(ctx, 9, -4);
    near(calls[0].params.Start as number[], [2, 1, 0], 'Start');
    near(calls[0].params.End as number[], [6, 1, 0], 'End');
  });

  it("divides a turned storey's rotation out, and writes the drawn rectangle as a polygon so it keeps its on-screen orientation", async () => {
    useViewerStore.setState({ addElementType: 'slab', addElementStoreyId: STOREY_B });
    const ctx = makeCtx();
    hits = [null, null];
    await click(ctx, 4, -5); // model (4, 5) → B-local R^T·(1, 2) = (2, -1)
    await click(ctx, 6, -8); // model (6, 8) → B-local R^T·(3, 5) = (5, -3)
    const params = calls[0].params as { Profile?: string; OuterCurve?: Array<[number, number]> };
    assert.equal(params.Profile, 'polygon');
    const expected: Array<[number, number]> = [[2, -1], [2, -3], [5, -3], [5, -1]];
    params.OuterCurve!.forEach((p, i) => near(p, expected[i], `corner ${i}`));
  });

  it('adds back BOTH offsets a georeferenced model is rendered without (origin shift + wasm RTC), and the mirror removes them again', async () => {
    // world = render + originShift + rtc. originShift is Y-up (IFC Y = −z);
    // the RTC offset is IFC Z-up. Renderer (5, ·, −4) = render plan (5, 4)
    // → world (5 + 10 + 100, 4 + 20 + 200) = (115, 224) → storey A at (3, 3).
    const coordinateInfo = { originShift: { x: 10, y: 0, z: -20 }, wasmRtcOffset: { x: 100, y: 200, z: 0 } };
    const model = useViewerStore.getState().models.get(MODEL)!;
    useViewerStore.setState({
      models: new Map([[MODEL, { ...model, geometryResult: { coordinateInfo } } as unknown as FederatedModel]]),
    });
    const ctx = makeCtx();
    hits = [null, null];
    await click(ctx, 5, -4);
    await click(ctx, 9, -4);
    near(calls[0].params.Start as number[], [112, 221, 0], 'Start');
    near(calls[0].params.End as number[], [116, 221, 0], 'End');

    const payload = authoredElementMeshPayload(
      { kind: 'wall', params: { Start: [112, 221, 0], End: [116, 221, 0], Thickness: 0.2, Height: 3 } },
      storeyAuthoringFrame(parsed, STOREY_A, coordinateInfo as Parameters<typeof storeyAuthoringFrame>[2]),
    );
    if (payload.type !== 'wall') throw new Error('expected a wall payload');
    near(payload.start, [5, 4, 0], 'mirror start, back under the click');
  });
});

describe('Add Element workplane: the instant 3D mirror folds the storey chain back in (#6233)', () => {
  it('a wall written storey-local at (2,1)→(6,1) on storey A is drawn at model (5,4)→(9,4), under the clicks', () => {
    const payload = authoredElementMeshPayload(
      { kind: 'wall', params: { Start: [2, 1, 0], End: [6, 1, 0], Thickness: 0.2, Height: 3 } },
      storeyAuthoringFrame(parsed, STOREY_A, undefined),
    );
    assert.equal(payload.type, 'wall');
    if (payload.type !== 'wall') return;
    near(payload.start, [5, 4, 0], 'start');
    near(payload.end, [9, 4, 0], 'end');
  });

  it("a slab polygon on turned storey B is drawn back at the model-frame corners it was clicked at", () => {
    const payload = authoredElementMeshPayload(
      { kind: 'slab', params: { Profile: 'polygon', OuterCurve: [[2, -1], [2, -3], [5, -3], [5, -1]], Thickness: 0.3 } },
      storeyAuthoringFrame(parsed, STOREY_B, undefined),
    );
    if (payload.type !== 'slab') throw new Error('expected a slab payload');
    const expected = [[4, 5, 0], [6, 5, 0], [6, 8, 0], [4, 8, 0]];
    payload.corners.forEach((c, i) => near(c, expected[i], `corner ${i}`));
  });
});

describe('Add Element workplane: the drawing plane is shown at the storey (#6233)', () => {
  it("moves the uncut plane preview to the target storey's floor while the tool is active", () => {
    useViewerStore.setState({ addElementStoreyId: STOREY_B });
    const clip = withAddElementWorkplane(useViewerStore.getState(), { sectionPlane: { axis: 'down', position: 50, enabled: false } });
    assert.deepEqual(clip.sectionPlane && { y: clip.sectionPlane.min, max: clip.sectionPlane.max, enabled: clip.sectionPlane.enabled },
      { y: 3, max: 3, enabled: false });
  });

  it('leaves an active cut, and every other tool, alone', () => {
    const cut = { sectionPlane: { axis: 'down' as const, position: 50, enabled: true } };
    assert.equal(withAddElementWorkplane(useViewerStore.getState(), cut), cut);
    useViewerStore.setState({ activeTool: 'select' });
    const preview = { sectionPlane: { axis: 'down' as const, position: 50, enabled: false } };
    assert.equal(withAddElementWorkplane(useViewerStore.getState(), preview), preview);
  });
});
