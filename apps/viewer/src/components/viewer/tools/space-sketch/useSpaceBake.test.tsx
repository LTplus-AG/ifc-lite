/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Space Sketch confirm-on-close (#2438).
 *
 * The decisions (dedup, floor-to-floor, which outline carries the area) are
 * pinned in `space-bake.test.ts`. What this file pins is the part that needs a
 * mounted hook because it is carried in a ref across calls: the ids this tool
 * authored per storey.
 *
 * A partial failure keeps the tool open so nothing is silently dropped, which
 * means confirming a second time is a normal path — and the second confirm has
 * to REPLACE what the first one created, not add a second copy of every room to
 * the file. That ledger lives in `generatedRef`, so it can only be exercised
 * through the hook.
 */

import '@/test/setup-dom.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useViewerStore } from '@/store/index.js';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { SpacePlateSession } from '@/lib/space-plate-session.js';
import type { Pt } from '@/lib/space-sketch-geometry.js';
import { useSpaceBake, type UseSpaceBake } from './useSpaceBake.js';

const MODEL = 'model-a';

/** A plate session with `n` unit-square rooms, as the bake reads it. */
function fakeSession(n: number, alive = true): SpacePlateSession {
  const rooms = Array.from({ length: n }, (_, i) => ({
    face: i,
    outline: [[i * 10, 0], [i * 10 + 2, 0], [i * 10 + 2, 2], [i * 10, 2]] as Pt[],
    area: 4,
    simple: true,
  }));
  return {
    alive,
    roomCount: n,
    rooms: () => rooms,
    boundaryOutline: (face: number) => rooms[face].outline,
  } as unknown as SpacePlateSession;
}

/** `existingSpaceFootprintsByStorey` short-circuits to empty without a source. */
const EMPTY_STORE = { source: undefined } as unknown as IfcDataStore;

interface Emitted { modelId: string; storeyId: number; name: string }

let added: Emitted[] = [];
let removed: Array<{ modelId: string; id: number }> = [];
let nextId = 0;
let failCalls: Set<number>;
let callSeq = 0;
let root: Root | null = null;
let container: HTMLElement | null = null;
let api: UseSpaceBake | null = null;
let sessions: Map<number, SpacePlateSession>;
/** Everything this file writes into the module-level store, so `afterEach` can
 *  put it all back — the viewer runs its whole suite in ONE process. */
let storeBackup: Record<string, unknown>;

function Harness() {
  const ref = { current: sessions };
  api = useSpaceBake({
    sketchModelId: MODEL,
    ifcDataStore: EMPTY_STORE,
    boundaryMode: 'center',
    sessionsRef: ref,
    floorToFloor: () => 3,
  });
  return null;
}

beforeEach(() => {
  added = [];
  removed = [];
  nextId = 5000;
  failCalls = new Set();
  callSeq = 0;
  sessions = new Map();
  const s = useViewerStore.getState();
  storeBackup = { addSpace: s.addSpace, removeEntity: s.removeEntity, typeVisibility: s.typeVisibility };
  useViewerStore.setState({
    addSpace: ((modelId: string, storeyId: number, params: { Name: string }) => {
      const seq = callSeq++;
      if (failCalls.has(seq)) return { error: `refused room ${seq}` };
      added.push({ modelId, storeyId, name: params.Name });
      return { expressId: nextId++ };
    }) as typeof s.addSpace,
    removeEntity: ((modelId: string, id: number) => { removed.push({ modelId, id }); }) as typeof s.removeEntity,
  });
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

describe('useSpaceBake', () => {
  it('creates one space per drafted room across every storey', () => {
    sessions.set(1, fakeSession(2));
    sessions.set(2, fakeSession(1));
    const res = api!.createAllSpaces();
    assert.deepEqual(res, { emitted: 3, floors: 2, error: null });
    assert.deepEqual(added.map((a) => a.storeyId), [1, 1, 2]);
    assert.deepEqual(added.map((a) => a.name), ['Space 1', 'Space 2', 'Space 1'],
      'names restart per storey');
    assert.equal(removed.length, 0, 'a first confirm removes nothing');
    assert.deepEqual(api!.createdIds(), [5000, 5001, 5002]);
  });

  it('REPLACES on a second confirm instead of duplicating the file', () => {
    // Reachable normally: a partial failure keeps the tool open, so the user
    // fixes it and confirms again. Without the per-storey id ledger the model
    // ends up with two IfcSpace for every room.
    sessions.set(1, fakeSession(2));
    api!.createAllSpaces();
    const firstIds = [...api!.createdIds()];
    added = [];

    const res = api!.createAllSpaces();
    assert.equal(res.emitted, 2, 'the same two rooms are re-created');
    assert.deepEqual(removed, firstIds.map((id) => ({ modelId: MODEL, id })),
      'and the previous pair is removed first');
    assert.deepEqual(api!.createdIds(), [5002, 5003], 'the ledger now holds only the new ids');
  });

  it('reports an addSpace failure instead of counting it as a dedup skip', () => {
    // A refused space is missing from the export. Reporting a null error would
    // let `confirmCreate` close the tool and discard the rest of the drafts.
    sessions.set(1, fakeSession(2));
    failCalls.add(0); // the first room is refused by the store
    const res = api!.createAllSpaces();
    assert.equal(res.emitted, 1);
    assert.match(res.error ?? '', /refused room 0/);
  });

  it('numbers surviving spaces by successful emission, leaving no gap', () => {
    sessions.set(1, fakeSession(3));
    failCalls.add(0);
    api!.createAllSpaces();
    assert.deepEqual(added.map((a) => a.name), ['Space 1', 'Space 2'],
      'the second room takes the freed number rather than showing a hole');
  });

  it('ignores a disposed or empty storey plate', () => {
    sessions.set(1, fakeSession(0));
    sessions.set(2, fakeSession(2, false));
    const res = api!.createAllSpaces();
    assert.deepEqual(res, { emitted: 0, floors: 0, error: null });
    assert.equal(added.length, 0);
  });

  it('reveals the IfcSpace class only when something was created', () => {
    useViewerStore.setState({
      typeVisibility: { ...useViewerStore.getState().typeVisibility, spaces: false },
    });
    api!.createAllSpaces(); // nothing drafted
    assert.equal(useViewerStore.getState().typeVisibility.spaces, false,
      'a no-op confirm must not change the user\'s visibility settings');

    sessions.set(1, fakeSession(1));
    api!.createAllSpaces();
    assert.equal(useViewerStore.getState().typeVisibility.spaces, true,
      'spaces are class-hidden by default, so a created space would be invisible');
  });
});
