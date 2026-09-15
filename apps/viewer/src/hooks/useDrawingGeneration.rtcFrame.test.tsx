/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { contiguousSourceBytes, type IfcDataStore } from '@ifc-lite/parser';
import type { Drawing2D } from '@ifc-lite/drawing-2d';
import type { GeometryResult, MeshData, RtcFrame } from '@ifc-lite/geometry';
import { useViewerStore } from '@/store';
import { __setOverlayWorkerFactoryForTest } from '@/lib/overlay-parse';
import { createEmptyFlatSymbolic } from '@/lib/overlay-parse/symbolic-flat';
import type { FlatProfiles } from '@/lib/overlay-parse/profiles-flat';
import { useDrawingGeneration } from './useDrawingGeneration.js';

const SECTION_PLANE = { axis: 'down' as const, position: 50, flipped: false };
const DISPLAY_OPTIONS = {
  showHiddenLines: false,
  useSymbolicRepresentations: true,
  show3DOverlay: false,
  scale: 50,
  showConstructionProjection: false,
};
const TYPE_VISIBILITY = {
  spaces: true,
  spatialZones: true,
  openings: true,
  virtualElements: true,
  site: true,
  ifcAnnotations: true,
};
const HIDDEN_IDS = new Set<number>();
const NOOP = () => {};

let root: Root | null = null;
let container: HTMLElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  container?.remove();
  container = null;
});

function box(): MeshData {
  const positions = new Float32Array([
    0, 0, 0, 2, 0, 0, 2, 2, 0, 0, 2, 0,
    0, 0, 2, 2, 0, 2, 2, 2, 2, 0, 2, 2,
  ]);
  return {
    expressId: 1,
    ifcType: 'IFCWALL',
    modelIndex: 0,
    geometryClass: 0,
    positions,
    normals: new Float32Array(positions.length),
    indices: new Uint32Array([
      0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6,
      0, 4, 5, 0, 5, 1, 3, 2, 6, 3, 6, 7,
      0, 3, 7, 0, 7, 4, 1, 5, 6, 1, 6, 2,
    ]),
    color: [0.5, 0.5, 0.5, 1],
  };
}

function geometry(frame?: RtcFrame): GeometryResult {
  const zero = { x: 0, y: 0, z: 0 };
  return {
    meshes: [box()],
    totalVertices: 8,
    totalTriangles: 12,
    coordinateInfo: {
      originShift: zero,
      originalBounds: { min: zero, max: { x: 2, y: 2, z: 2 } },
      shiftedBounds: { min: zero, max: { x: 2, y: 2, z: 2 } },
      hasLargeCoordinates: false,
      ...(frame ? { wasmRtcFrame: frame } : {}),
    },
  };
}

interface Request { id: number; kind?: string; frame?: RtcFrame }

function symbolic(points: number[]) {
  const flat = createEmptyFlatSymbolic();
  flat.typeNames = ['IfcWall'];
  flat.polyPoints = Float32Array.from(points);
  flat.polyStart = Uint32Array.from([0, points.length / 2]);
  flat.polyOwner = Uint32Array.from([1]);
  flat.polyWorldY = Float32Array.from([1]);
  flat.polyFlags = Uint8Array.from([0]);
  flat.polyType = Uint16Array.from([0]);
  return flat;
}

const SYMBOL_A = symbolic([0, 0, 2, 0]);
const SYMBOL_B = symbolic([0, 0, 2, 0, 2, 2]);

function profile(expressId: number): FlatProfiles {
  return {
    typeNames: ['IfcWall'],
    typeIndex: Uint16Array.from([0]),
    expressId: Uint32Array.from([expressId]),
    outerPoints: Float32Array.from([-0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, 0.5]),
    outerStart: Uint32Array.from([0, 8]),
    holeCounts: new Uint32Array(0),
    holeCountStart: Uint32Array.from([0, 0]),
    holePoints: new Float32Array(0),
    holePointStart: Uint32Array.from([0, 0]),
    transform: Float32Array.from([
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      1, 0, 1, 1,
    ]),
    extrusionDir: Float32Array.from([0, 0, 1]),
    extrusionDepth: Float32Array.from([2]),
    skippedExpressIds: new Uint32Array(0),
  };
}

function installHeldWorkers(requests: Request[]): () => void {
  const previous = __setOverlayWorkerFactoryForTest(() => {
    const worker = {
      onmessage: null as ((event: { data: unknown }) => void) | null,
      postMessage(request: Request) { requests.push(request); },
      terminate() {},
    };
    workers.push(worker);
    return worker as unknown as Worker;
  });
  return () => __setOverlayWorkerFactoryForTest(previous);
}

const workers: Array<{
  onmessage: ((event: { data: unknown }) => void) | null;
}> = [];

async function turns(count = 2): Promise<void> {
  for (let i = 0; i < count; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

function mountHarness(publications: Drawing2D[]): { run: () => Promise<void> } {
  let run: (() => Promise<void>) | null = null;
  const publish = (drawing: Drawing2D | null) => { if (drawing) publications.push(drawing); };
  function Probe(): null {
    const geometryResult = useViewerStore((state) => state.geometryResult);
    const ifcDataStore = useViewerStore((state) => state.ifcDataStore);
    const models = useViewerStore((state) => state.models);
    const hook = useDrawingGeneration({
      activeTool: 'select',
      geometryResult,
      ifcDataStore,
      sectionPlane: SECTION_PLANE,
      displayOptions: DISPLAY_OPTIONS,
      typeVisibility: TYPE_VISIBILITY,
      combinedHiddenIds: HIDDEN_IDS,
      combinedIsolatedIds: null,
      computedIsolatedIds: null,
      models,
      panelVisible: true,
      drawing: null,
      setDrawing: publish,
      setDrawingStatus: NOOP,
      setDrawingProgress: NOOP,
      setDrawingError: NOOP,
    });
    run = hook.generateDrawing;
    return null;
  }
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<Probe />));
  return { run: () => run!() };
}

function mountProjectionHarness(publications: Drawing2D[]): { run: () => Promise<void> } {
  let run: (() => Promise<void>) | null = null;
  function Probe(): null {
    const geometryResult = useViewerStore((state) => state.geometryResult);
    const ifcDataStore = useViewerStore((state) => state.ifcDataStore);
    const models = useViewerStore((state) => state.models);
    const hook = useDrawingGeneration({
      activeTool: 'select',
      geometryResult,
      ifcDataStore,
      sectionPlane: SECTION_PLANE,
      displayOptions: {
        ...DISPLAY_OPTIONS,
        useSymbolicRepresentations: false,
        showConstructionProjection: true,
      },
      typeVisibility: TYPE_VISIBILITY,
      combinedHiddenIds: HIDDEN_IDS,
      combinedIsolatedIds: null,
      computedIsolatedIds: null,
      models,
      panelVisible: false,
      drawing: null,
      setDrawing: (drawing) => { if (drawing) publications.push(drawing); },
      setDrawingStatus: NOOP,
      setDrawingProgress: NOOP,
      setDrawingError: NOOP,
    });
    run = hook.generateDrawing;
    return null;
  }
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<Probe />));
  return { run: () => run!() };
}

describe('2D drawing RTC publication and races (#4799)', () => {
  it('never aliases construction profiles between pending sources', async () => {
    workers.length = 0;
    const requests: Request[] = [];
    const restore = installHeldWorkers(requests);
    const storeA = {
      source: contiguousSourceBytes(new TextEncoder().encode('pending profile source A #4799')),
    } as unknown as IfcDataStore;
    const storeB = {
      source: contiguousSourceBytes(new TextEncoder().encode('pending profile source B #4799')),
    } as unknown as IfcDataStore;
    useViewerStore.setState({
      models: new Map(),
      activeModelId: null,
      ifcDataStore: storeA,
      geometryResult: geometry(),
      loading: true,
    } as never);
    const publications: Drawing2D[] = [];

    try {
      const harness = mountProjectionHarness(publications);
      await act(async () => { await harness.run(); });
      assert.equal(requests.length, 0, 'pending source A must not populate the shared null cache key');

      await act(async () => {
        useViewerStore.setState({ ifcDataStore: storeB, geometryResult: geometry() } as never);
        await turns();
      });
      await act(async () => { await harness.run(); });
      assert.equal(requests.length, 0, 'pending source B must not reuse or populate source A\'s key');

      await act(async () => {
        useViewerStore.setState({ loading: false } as never);
        await turns();
      });
      let completed: Promise<void> | undefined;
      await act(async () => {
        completed = harness.run();
        await turns();
      });
      assert.equal(requests.length, 1);
      assert.equal(requests[0].kind, 'profiles');

      await act(async () => {
        workers[0].onmessage?.({
          data: { id: requests[0].id, ok: true, profiles: profile(202) },
        });
        await completed;
      });
      const projectedIds = new Set(
        publications.at(-1)?.lines
          .filter((line) => line.category !== 'cut')
          .map((line) => line.entityId),
      );
      assert.ok(projectedIds.has(202), 'source B must render its own extracted profile');
      assert.ok(!projectedIds.has(101), 'source A profiles must not survive the pending switch');
    } finally {
      restore();
    }
  });

  it('retries an ordinary pending drawing in standalone mode when legacy loading completes', async () => {
    workers.length = 0;
    const requests: Request[] = [];
    const restore = installHeldWorkers(requests);
    const store = {
      source: contiguousSourceBytes(new TextEncoder().encode('drawing pending standalone #4799')),
    } as unknown as IfcDataStore;
    useViewerStore.setState({
      models: new Map(),
      activeModelId: null,
      ifcDataStore: store,
      geometryResult: geometry(),
      loading: true,
    } as never);
    const publications: Drawing2D[] = [];

    try {
      mountHarness(publications);
      await act(async () => { await turns(); });
      assert.equal(requests.length, 0, 'pending provenance must not dispatch a guessed parse');

      await act(async () => {
        useViewerStore.setState({ loading: false } as never);
        await turns();
      });
      assert.equal(requests.length, 1, 'pending to standalone must automatically retry');
      assert.equal('frame' in requests[0], false);

      await act(async () => {
        workers[0].onmessage?.({
          data: { id: requests[0].id, ok: true, flat: SYMBOL_B },
        });
        await turns(3);
      });
      assert.ok(publications.length > 0, 'the retried drawing must publish');
      assert.deepEqual(publications.at(-1)?.lines.map((line) => line.line), [
        { start: { x: 0, y: 0 }, end: { x: 2, y: 0 } },
        { start: { x: 2, y: 0 }, end: { x: 2, y: 2 } },
      ]);
    } finally {
      restore();
    }
  });

  it('drops frame A after an in-flight change, publishes B, and reuses only the B cache', async () => {
    workers.length = 0;
    const requests: Request[] = [];
    const restore = installHeldWorkers(requests);
    const store = {
      source: contiguousSourceBytes(new TextEncoder().encode('drawing exact frame race #4799')),
    } as unknown as IfcDataStore;
    const frameA: RtcFrame = { x: 10, y: 20, z: 30, needsShift: true };
    const frameB: RtcFrame = { x: 40, y: 50, z: 60, needsShift: false };
    useViewerStore.setState({
      models: new Map(),
      activeModelId: null,
      ifcDataStore: store,
      geometryResult: geometry(frameA),
      loading: false,
    } as never);
    const publications: Drawing2D[] = [];

    try {
      const harness = mountHarness(publications);
      await act(async () => { await turns(); });
      assert.equal(requests.length, 1);
      assert.deepEqual(requests[0].frame, frameA);

      await act(async () => {
        useViewerStore.setState({ geometryResult: geometry(frameB) } as never);
        await turns();
      });
      assert.equal(requests.length, 1, 'the drawing queue must not run B concurrently with A');

      await act(async () => {
        workers[0].onmessage?.({
          data: { id: requests[0].id, ok: true, flat: SYMBOL_A },
        });
        await turns(4);
      });
      assert.equal(publications.length, 0, 'superseded frame A must not publish');
      assert.equal(requests.length, 2, 'frame B must run after stale A drains');
      assert.deepEqual(requests[1].frame, frameB);

      await act(async () => {
        workers[1].onmessage?.({
          data: { id: requests[1].id, ok: true, flat: SYMBOL_B },
        });
        await turns(4);
      });
      assert.equal(publications.length, 1, 'only the current frame B may publish');
      const bLines = publications[0].lines.map((line) => line.line);
      assert.deepEqual(bLines, [
        { start: { x: 0, y: 0 }, end: { x: 2, y: 0 } },
        { start: { x: 2, y: 0 }, end: { x: 2, y: 2 } },
      ], 'the published drawing must contain frame B\'s two-segment symbol');

      await act(async () => { await harness.run(); });
      assert.equal(requests.length, 2, 'a repeated B drawing must reuse B, not stale A');
      assert.deepEqual(publications.at(-1)?.lines.map((line) => line.line), bLines);
    } finally {
      restore();
    }
  });
});
