/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The frame crossing in the Space Sketch bake (#4500), in both directions.
 *
 * Space Sketch derives its room outlines from RENDERED meshes
 * (`wallRectsFromMeshes`), so they arrive with the storey's placement chain
 * already applied. `addSpace` anchors the profile to the storey's own
 * placement, so a reader applies that chain again: the outline has to be
 * divided out before it is written, and the storey-local footprints
 * `existingSpaceFootprintsByStorey` returns have to be folded the other way
 * before the dedup compares them against drafts.
 *
 * The fixture's chain is deliberately non-commuting — a rotated site at
 * (1000, 2000) with a rotated storey at (100, 200) under it — so applying it
 * twice, applying it once in the wrong direction, and applying it not at all
 * land on three different answers. A storey at the origin without rotation
 * would make every one of those identical, which is exactly why the defect
 * survived: that is what most models look like.
 */

import '@/test/setup-dom.js';
import { describe, it, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { useViewerStore } from '@/store/index.js';
import type { SpacePlateSession } from '@/lib/space-plate-session.js';
import type { Pt } from '@/lib/space-sketch-geometry.js';
import { useSpaceBake, type UseSpaceBake } from './useSpaceBake.js';

const MODEL = 'model-a';
const STOREY = 4;

// Site #2 at (1000, 2000) turned 90° (RefDirection (0,1,0)); building #3 at the
// site origin; storey #4 at (100, 200) in the building, turned by the 3-4-5
// direction (0.6, 0.8, 0).
//
// Composed to the model's world frame the storey is therefore
//   origin = (1000, 2000) + R_site·(100, 200) = (800, 2100)
//   axisX  = R_site·(0.6, 0.8)                = (-0.8, 0.6)
const BASE = `ISO-10303-21;
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
#12=IFCAXIS2PLACEMENT3D(#91,$,#93);
#91=IFCCARTESIANPOINT((1000.,2000.,0.));
#93=IFCDIRECTION((0.,1.,0.));
#3=IFCBUILDING('0BUILDING000000000000',$,'Bldg',$,$,#13,$,$,.ELEMENT.,$,$,$);
#13=IFCLOCALPLACEMENT(#11,#14);
#14=IFCAXIS2PLACEMENT3D(#92,$,$);
#92=IFCCARTESIANPOINT((0.,0.,0.));
#4=IFCBUILDINGSTOREY('0STOREY00000000000000',$,'Storey',$,$,#10,$,$,.ELEMENT.,0.);
#10=IFCLOCALPLACEMENT(#13,#15);
#15=IFCAXIS2PLACEMENT3D(#94,$,#95);
#94=IFCCARTESIANPOINT((100.,200.,0.));
#95=IFCDIRECTION((0.6,0.8,0.));
#70=IFCRELAGGREGATES('0RELAGG0000000000000',$,$,$,#2,(#3));
#71=IFCRELAGGREGATES('0RELAGG0000000000001',$,$,$,#3,(#4));
`;

// One IfcSpace already in the file, authored the way `addSpaceToStore` does:
// placement relative to the storey's own placement, profile points STOREY-
// LOCAL. Its footprint is `ROOM` below, divided through the storey chain.
const EXISTING_SPACE = `#200=IFCSPACE('0SPACE000000000000000',$,'Existing',$,$,#201,#210,$,.ELEMENT.,.INTERNAL.,$);
#201=IFCLOCALPLACEMENT(#10,#202);
#202=IFCAXIS2PLACEMENT3D(#203,$,$);
#203=IFCCARTESIANPOINT((0.,0.,0.));
#210=IFCPRODUCTDEFINITIONSHAPE($,$,(#211));
#211=IFCSHAPEREPRESENTATION(#7,'Body','SweptSolid',(#212));
#212=IFCEXTRUDEDAREASOLID(#213,#216,#218,3.);
#213=IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,#214);
#214=IFCPOLYLINE((#220,#221,#222,#223));
#220=IFCCARTESIANPOINT((-5.,-10.));
#221=IFCCARTESIANPOINT((-6.6,-11.2));
#222=IFCCARTESIANPOINT((-5.4,-12.8));
#223=IFCCARTESIANPOINT((-3.8,-11.6));
#216=IFCAXIS2PLACEMENT3D(#217,$,$);
#217=IFCCARTESIANPOINT((0.,0.,0.));
#218=IFCDIRECTION((0.,0.,1.));
#72=IFCRELAGGREGATES('0RELAGG0000000000002',$,$,$,#4,(#200));
`;

const TAIL = `ENDSEC;
END-ISO-10303-21;
`;

/** A 2 m square drawn in the ROOM frame, next to the storey's world origin. */
const ROOM: Pt[] = [[810, 2105], [812, 2105], [812, 2107], [810, 2107]];

/**
 * `ROOM` in the storey-local frame — `Rᵀ·(p − (800, 2100))` with
 * `R = [[-0.8, -0.6], [0.6, -0.8]]`, worked by hand so the expectation is not
 * the code under test run backwards. Side length is still 2 m, as a rigid
 * motion requires.
 */
const ROOM_STOREY_LOCAL: Pt[] = [[-5, -10], [-6.6, -11.2], [-5.4, -12.8], [-3.8, -11.6]];

async function parse(ifc: string): Promise<IfcDataStore> {
  return new IfcParser().parseColumnar(new TextEncoder().encode(ifc).buffer);
}

function oneRoomSession(outline: Pt[]): SpacePlateSession {
  const rooms = [{ face: 0, outline, area: 4, simple: true }];
  return {
    alive: true,
    roomCount: 1,
    rooms: () => rooms,
    boundaryOutline: () => outline,
  } as unknown as SpacePlateSession;
}

let withSpace: IfcDataStore;
let withoutSpace: IfcDataStore;

before(async () => {
  withoutSpace = await parse(BASE + TAIL);
  withSpace = await parse(BASE + EXISTING_SPACE + TAIL);
});

let emittedCurves: Pt[][] = [];
let previewCurves: Array<Pt[] | undefined> = [];
let root: Root | null = null;
let container: HTMLElement | null = null;
let api: UseSpaceBake | null = null;
let sessions: Map<number, SpacePlateSession>;
let store: IfcDataStore;
let storeBackup: Record<string, unknown>;

function Harness() {
  const ref = { current: sessions };
  api = useSpaceBake({
    sketchModelId: MODEL,
    ifcDataStore: store,
    boundaryMode: 'center',
    sessionsRef: ref,
    floorToFloor: () => 3,
    coordinateInfo: undefined,
  });
  return null;
}

function mount() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => { root!.render(<Harness />); });
}

beforeEach(() => {
  emittedCurves = [];
  previewCurves = [];
  sessions = new Map();
  const s = useViewerStore.getState();
  storeBackup = { addSpace: s.addSpace, removeEntity: s.removeEntity, typeVisibility: s.typeVisibility };
  useViewerStore.setState({
    addSpace: ((_modelId: string, _storeyId: number, params: { OuterCurve: Pt[] }, preview?: Pt[]) => {
      emittedCurves.push(params.OuterCurve);
      previewCurves.push(preview);
      return { expressId: 5000 + emittedCurves.length };
    }) as typeof s.addSpace,
    removeEntity: (() => true) as typeof s.removeEntity,
  });
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  container?.remove();
  useViewerStore.setState(storeBackup as Partial<ReturnType<typeof useViewerStore.getState>>);
});

function assertNear(actual: Pt[], expected: Pt[], what: string) {
  assert.equal(actual.length, expected.length, `${what}: point count`);
  actual.forEach((p, i) => {
    assert.ok(
      Math.abs(p[0] - expected[i][0]) < 1e-6 && Math.abs(p[1] - expected[i][1]) < 1e-6,
      `${what}: point ${i} was (${p[0]}, ${p[1]}), expected (${expected[i][0]}, ${expected[i][1]})`,
    );
  });
}

describe('useSpaceBake: the storey frame crossing (#4500)', () => {
  it('writes the outline STOREY-LOCAL, so the storey chain is applied once', () => {
    store = withoutSpace;
    mount();
    sessions.set(STOREY, oneRoomSession(ROOM));
    const res = api!.createAllSpaces();
    assert.deepEqual(res, { emitted: 1, floors: 1, error: null });
    assert.equal(emittedCurves.length, 1);
    // Handing `addSpace` the room frame unchanged writes (810, 2105) here, and
    // the reader then puts the room ~2.4 km from the walls it was drawn
    // between. Handing it the chain applied a SECOND time writes something
    // else again — the fixture's rotation is what tells those two apart.
    assertNear(emittedCurves[0], ROOM_STOREY_LOCAL, 'emitted OuterCurve');
  });

  it('draws the immediate 3D mirror where the user drew the room', () => {
    // `buildElementMesh` maps its corners straight into the renderer's plan
    // without putting the storey chain back, so handing it the storey-local
    // profile would make the confirmed room jump by the whole chain and then
    // come back on reload. The preview stays in the room frame.
    store = withoutSpace;
    mount();
    sessions.set(STOREY, oneRoomSession(ROOM));
    api!.createAllSpaces();
    assert.equal(previewCurves.length, 1);
    assertNear(previewCurves[0]!, ROOM, 'preview corners');
  });

  it('folds authored footprints back to the room frame, so dedup still matches', () => {
    // The reverse direction: `existingSpaceFootprintsByStorey` returns
    // STOREY-LOCAL rings, and `planStoreySpaces` tests draft centroids — which
    // are in the room frame — against them. Compared in different frames the
    // overlap test matches nothing, and confirm lays a second room on top of
    // every room already in the file.
    store = withSpace;
    mount();
    sessions.set(STOREY, oneRoomSession(ROOM));
    const res = api!.createAllSpaces();
    assert.deepEqual(res, { emitted: 0, floors: 0, error: null },
      'the room sits exactly on the authored space, so nothing is emitted');
    assert.equal(emittedCurves.length, 0);
  });

  it('refuses a storey whose placement will not resolve rather than guessing', () => {
    store = withoutSpace;
    mount();
    sessions.set(999, oneRoomSession(ROOM)); // no such storey in the file
    const res = api!.createAllSpaces();
    assert.equal(res.emitted, 0);
    assert.equal(emittedCurves.length, 0, 'no room is authored on an unresolvable frame');
    assert.match(res.error ?? '', /placement not resolvable/);
  });
});
