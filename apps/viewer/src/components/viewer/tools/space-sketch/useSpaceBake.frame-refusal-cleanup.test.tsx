/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A storey that resolved on one confirm and refuses on the next (a review
 * finding against #4503): does the ledger `generatedRef` keeps stay
 * consistent with what is actually in the model, and does a LATER successful
 * confirm still clean up correctly?
 *
 * `createAllSpaces` `continue`s past a storey whose `storeyPlanFrame` refuses,
 * which skips `createSpacesForStorey` — the only place that removes the ids
 * `generatedRef` recorded for that storey. This pins what that skip actually
 * does across a three-confirm sequence — author, refuse, author again — on
 * the SAME hook instance (the overlay that owns it never unmounts between
 * confirms, so `generatedRef` is not reset between them either).
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
const STOREY = 1;

const HEAD = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#30=IFCPROJECT('0PROJECT000000000000',$,'Proj',$,$,$,$,(#31),#32);
#31=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#33,$);
#33=IFCAXIS2PLACEMENT3D(#34,$,$);
#34=IFCCARTESIANPOINT((0.,0.,0.));
#32=IFCUNITASSIGNMENT((#35));
#35=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
`;
const TAIL = `ENDSEC;
END-ISO-10303-21;
`;

// Storey #1 with an ordinary, resolvable placement at the origin.
const RESOLVABLE_STOREY = `#1=IFCBUILDINGSTOREY('0STOREY00000000000001',$,'L1',$,$,#11,$,$,.ELEMENT.,0.);
#11=IFCLOCALPLACEMENT($,#12);
#12=IFCAXIS2PLACEMENT3D(#13,$,$);
#13=IFCCARTESIANPOINT((0.,0.,0.));
`;

// Same storey #1, same express id, but its placement's Axis has tipped out of
// plan (not +Z) — `storeyPlanFrame` refuses rather than projecting it. Stands
// in for a re-entrant edit that retargets the storey's `ObjectPlacement`
// between two confirms.
const REFUSING_STOREY = `#1=IFCBUILDINGSTOREY('0STOREY00000000000001',$,'L1',$,$,#11,$,$,.ELEMENT.,0.);
#11=IFCLOCALPLACEMENT($,#12);
#12=IFCAXIS2PLACEMENT3D(#13,#14,$);
#13=IFCCARTESIANPOINT((0.,0.,0.));
#14=IFCDIRECTION((1.,0.,0.));
`;

async function parse(ifc: string): Promise<IfcDataStore> {
  return new IfcParser().parseColumnar(new TextEncoder().encode(ifc).buffer);
}

function roomsSession(n: number): SpacePlateSession {
  const rooms = Array.from({ length: n }, (_, i) => ({
    face: i,
    outline: [[i * 10, 0], [i * 10 + 2, 0], [i * 10 + 2, 2], [i * 10, 2]] as Pt[],
    area: 4,
    simple: true,
  }));
  return {
    alive: true,
    roomCount: n,
    rooms: () => rooms,
    boundaryOutline: (face: number) => rooms[face].outline,
  } as unknown as SpacePlateSession;
}

let resolvable: IfcDataStore;
let refusing: IfcDataStore;

before(async () => {
  resolvable = await parse(HEAD + RESOLVABLE_STOREY + TAIL);
  refusing = await parse(HEAD + REFUSING_STOREY + TAIL);
});

let added: number[] = [];
let removed: number[] = [];
let nextId = 0;
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

/** Re-render the SAME mounted hook instance — `generatedRef` is a `useRef`,
 *  so this is what "confirm again without closing the tool" looks like. */
function rerender() {
  act(() => { root!.render(<Harness />); });
}

beforeEach(() => {
  added = [];
  removed = [];
  nextId = 5000;
  sessions = new Map();
  const s = useViewerStore.getState();
  storeBackup = { addSpace: s.addSpace, removeEntity: s.removeEntity, typeVisibility: s.typeVisibility };
  useViewerStore.setState({
    addSpace: ((_modelId: string, _storeyId: number, _params: { Name: string }) => {
      const id = nextId++;
      added.push(id);
      return { expressId: id };
    }) as typeof s.addSpace,
    removeEntity: ((_modelId: string, id: number) => { removed.push(id); }) as typeof s.removeEntity,
  });
  store = resolvable;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => { root!.render(<Harness />); });
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  container?.remove();
  useViewerStore.setState(storeBackup as Partial<ReturnType<typeof useViewerStore.getState>>);
});

describe('useSpaceBake: a storey that stops resolving between confirms', () => {
  it('does not accumulate duplicates across a refuse/retry cycle, and cleans up once the frame resolves again', () => {
    // Confirm #1: the frame resolves, two rooms are authored.
    sessions.set(STOREY, roomsSession(2));
    const res1 = api!.createAllSpaces();
    assert.deepEqual(res1, { emitted: 2, floors: 1, error: null });
    const firstIds = [...api!.createdIds()];
    assert.equal(firstIds.length, 2, 'sanity: two spaces were authored');
    assert.equal(removed.length, 0, 'first confirm removes nothing');
    added = []; // isolate confirm #2's own effects from confirm #1's

    // Confirm #2: the storey's placement now tips out of plan (edit,
    // federated swap, …) — `storeyPlanFrame` refuses it. The user has not
    // touched the draft; re-confirming is a normal path (a partial failure
    // elsewhere in a multi-storey confirm keeps the tool open).
    store = refusing;
    rerender();
    const res2 = api!.createAllSpaces();
    assert.equal(res2.emitted, 0, 'nothing new is authored for a refusing frame');
    assert.match(res2.error ?? '', /placement not resolvable/);
    // The contested claim: does the second confirm silently duplicate the
    // storey's spaces, or leave the ledger (and the model) exactly as the
    // first confirm left it?
    assert.equal(added.length, 0, 'no new space is created on a refusing frame');
    assert.deepEqual(api!.createdIds(), firstIds,
      'the ledger still names the spaces that are actually in the model — ' +
      'not doubled, not forgotten');

    // Confirm #3: the placement resolves again (the edit is undone, or the
    // federated model is swapped back). A later successful confirm must still
    // replace, not add to, what confirm #1 created — proving confirm #2 did
    // not silently break the ledger's bookkeeping.
    store = resolvable;
    rerender();
    const res3 = api!.createAllSpaces();
    assert.equal(res3.emitted, 2);
    assert.deepEqual(removed, firstIds, 'confirm #3 removes exactly the ids confirm #1 created');
    const finalIds = api!.createdIds();
    assert.equal(finalIds.length, 2, 'the model ends up with 2 spaces for this storey, not 4');
    assert.deepEqual(finalIds, added, 'the ledger matches what was actually (re-)created');
  });
});
