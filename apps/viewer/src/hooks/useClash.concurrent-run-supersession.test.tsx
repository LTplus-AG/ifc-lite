/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Supersession race between two clash jobs over the SAME, unchanged
 * federation (issue #2802 sweep).
 *
 * `publishClashResult` (`useClash.ts`) guards every write to `clashResult`
 * with `clashFederationIsCurrent(federationIdentity, state.models)` — but
 * that identity is keyed on the MODEL SET, not on which call started it. Two
 * calls issued while the models are untouched carry the SAME identity, so
 * the guard cannot tell a call the user is still waiting on from one they
 * have moved past. Nothing else checks "is this still the most recently
 * started job" before the publish.
 *
 * This reproduces it with `run()` (an "All elements" detection over a large,
 * fully-overlapping element set - real narrow-phase work, so it holds the
 * thread across several `yieldToEventLoop()` checkpoints, hundreds of ms of
 * real wall time) started first, and `runDuplicates()` (bounded, effectively
 * a single 250 ms frame wait plus a synchronous scan) started SECOND, while
 * `run()` is already in its narrow phase. `runDuplicates()` legitimately
 * finishes first - it is both simpler and started when most of `run()`'s
 * narrow-phase work was still ahead of it. `run()` finishes after, and today
 * publishes its (superseded) result over the one from the call the user
 * actually made most recently.
 *
 * The two jobs are distinguished by `clashResult.rulesRun[0].id`
 * (`'all-clashes'` vs `'duplicates'`) - a marker with nothing to do with the
 * guard under test.
 *
 * ## The interleaving is real, not simulated
 *
 * `runDuplicates()` is fired from a store subscription the moment `run()`'s
 * progress reaches the NARROW phase - i.e. after `run()`'s own broad phase
 * has already built its candidate pairs and started the narrow loop, with
 * essentially all of the narrow-phase compute (the bulk of its wall time)
 * still ahead of it. No `await flush()` sits between that firing and either
 * promise settling.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import type { ClashRule } from '@ifc-lite/clash';
import type { CoordinateInfo, GeometryResult, MeshData } from '@ifc-lite/geometry';
import { useViewerStore, type FederatedModel } from '@/store';
import { useClash } from './useClash.js';

// ─── Fixture: N mutually-overlapping unit boxes (real narrow-phase work) ───

function ifc4(body: string): string {
  return [
    'ISO-10303-21;',
    'HEADER;',
    "FILE_DESCRIPTION((''),'2;1');",
    "FILE_NAME('','',(''),(''),'','','');",
    "FILE_SCHEMA(('IFC4'));",
    'ENDSEC;',
    'DATA;',
    body,
    'ENDSEC;',
    'END-ISO-10303-21;',
    '',
  ].join('\n');
}

const WALL_COUNT = 200;

function wallsBody(n: number): string {
  const lines: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const guid = `0${String(i).padStart(21, 'a')}`.slice(0, 22);
    lines.push(`#${i + 1}=IFCWALL('${guid}',$,'Wall ${i}',$,$,$,$,$,.STANDARD.);`);
  }
  return lines.join('\n');
}

async function parse(body: string): Promise<IfcDataStore> {
  const bytes = new TextEncoder().encode(ifc4(body));
  return new IfcParser().parseColumnar(bytes.buffer as ArrayBuffer, { disableWorkerScan: true });
}

/** A unit box, clustered tightly so every pair of boxes overlaps (maximises
 *  candidate pairs out of the broad phase, so the narrow phase has real work
 *  to hold the thread across several yield checkpoints). */
function boxMesh(expressId: number, i: number): MeshData {
  const dx = (i % 20) * 0.05;
  const dy = Math.floor(i / 20) * 0.05;
  const positions = new Float32Array([
    dx, dy, 0, dx + 1, dy, 0, dx + 1, dy + 1, 0, dx, dy + 1, 0,
    dx, dy, 1, dx + 1, dy, 1, dx + 1, dy + 1, 1, dx, dy + 1, 1,
  ]);
  const indices = new Uint32Array([
    0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6,
    0, 4, 5, 0, 5, 1, 1, 5, 6, 1, 6, 2,
    2, 6, 7, 2, 7, 3, 3, 7, 4, 3, 4, 0,
  ]);
  return {
    expressId,
    ifcType: 'IfcWall',
    positions,
    normals: new Float32Array(positions.length),
    indices,
    color: [0.5, 0.5, 0.5, 1],
  };
}

function geometry(meshes: MeshData[]): GeometryResult {
  const bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 2, y: 2, z: 1 } };
  const coordinateInfo: CoordinateInfo = {
    originShift: { x: 0, y: 0, z: 0 },
    originalBounds: bounds,
    shiftedBounds: bounds,
    hasLargeCoordinates: false,
  };
  return { meshes, totalTriangles: 12 * meshes.length, totalVertices: 8 * meshes.length, coordinateInfo };
}

function model(id: string, store: IfcDataStore, meshes: MeshData[]): FederatedModel {
  return {
    id,
    name: `${id}.ifc`,
    ifcDataStore: store,
    geometryResult: geometry(meshes),
    visible: true,
    collapsed: false,
    schemaVersion: 'IFC4',
    loadedAt: 0,
    fileSize: 0,
    idOffset: 0,
    maxExpressId: WALL_COUNT,
  };
}

const ALL_RULE: ClashRule = { id: 'all-clashes', name: 'All elements', a: '*', mode: 'hard' };

// ─── Harness ────────────────────────────────────────────────────────────

type ClashApi = ReturnType<typeof useClash>;
let api: ClashApi | null = null;

function Probe(): null {
  api = useClash();
  return null;
}

let root: Root | null = null;

async function seed(): Promise<void> {
  const store = await parse(wallsBody(WALL_COUNT));
  const meshes: MeshData[] = [];
  for (let i = 0; i < WALL_COUNT; i += 1) meshes.push(boxMesh(i + 1, i));
  const models = new Map<string, FederatedModel>([['A', model('A', store, meshes)]]);
  useViewerStore.setState({
    models,
    activeModelId: 'A',
    clashResult: null,
    clashRawResult: null,
    clashGroups: null,
    clashError: null,
    clashRunning: false,
    clashSelectedId: null,
    isolatedEntities: null,
    ghostExceptEntities: null,
  });
  useViewerStore.getState().registerModelOffset('A', 100);
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<Probe />);
  });
  assert.ok(api, 'useClash must be mounted');
}

/** Fire `action` the moment `run()`'s progress first reaches NARROW phase -
 *  after the broad phase has built its candidate pairs, with the narrow
 *  phase's compute (the bulk of the run's wall time) still ahead of it. */
function fireAtNarrowPhase(action: () => void): () => void {
  let fired = false;
  return useViewerStore.subscribe((s) => {
    if (fired || s.clashProgress?.phase !== 'narrow') return;
    fired = true;
    action();
  });
}

beforeEach(() => {
  api = null;
});

afterEach(async () => {
  const current = root;
  root = null;
  if (current) await act(async () => current.unmount());
});

describe('useClash - concurrent-run supersession (#2802)', () => {
  it('a later runDuplicates() that finishes first must not be overwritten by an earlier, slower run() finishing after it', async () => {
    await seed();

    let duplicatesStarted: Promise<void> | undefined;
    const unsub = fireAtNarrowPhase(() => {
      duplicatesStarted = api!.runDuplicates();
    });

    await act(async () => {
      await api!.run([ALL_RULE]);
      // `run()`'s own promise resolving does not guarantee `runDuplicates()`
      // (fired from inside its progress callback) has settled yet - wait for
      // it explicitly so both jobs are fully done before asserting.
      await duplicatesStarted;
    });
    unsub();

    assert.ok(duplicatesStarted, 'setup sanity: runDuplicates() must have fired mid-run() flight');

    const s = useViewerStore.getState();
    assert.ok(s.clashResult, 'a result must be published');
    assert.equal(
      s.clashResult!.rulesRun[0]?.id,
      'duplicates',
      'runDuplicates() was the call started SECOND (while run() was already mid-flight) and it finished ' +
        'FIRST - it is the one the user is waiting on. The earlier, slower run() finishing later must not ' +
        'overwrite it just because it lands last.',
    );
  });
});
