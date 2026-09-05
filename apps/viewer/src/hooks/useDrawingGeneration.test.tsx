/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Type-library geometry must not bleed into the standard 2D drawing (#2058).
 *
 * `geometryResult.meshes` carries the whole scene — placed occurrences AND the
 * type-library copies the wasm mesh pass emits (`geometryClass` 1 = orphan
 * type, 2 = instanced type). The 3D viewport routes that set through
 * `isMeshVisibleInViewMode`, so class 2 never reaches the Model view. The 2D
 * drawing generator filtered only on hiding/isolation, so every instanced type
 * template was cut and drawn on top of the plan — AC20-FZK-Haus alone carries
 * 32 such meshes (IfcWallType/IfcDoorType/IfcWindowType) against 285
 * occurrence meshes.
 *
 * These render the real hook (no mocked generator): two boxes straddling one
 * plan cut, one occurrence and one type template, and assert on the entity ids
 * that come back in the generated `Drawing2D`.
 */

import '@/test/setup-dom.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act, StrictMode, useCallback, useState } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { Drawing2DGenerator, type Drawing2D } from '@ifc-lite/drawing-2d';
import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import { useDrawingGeneration } from './useDrawingGeneration.js';

// ─── Fixture ─────────────────────────────────────────────────────────────

/** Axis-aligned box in render space (Y-up), 12 triangles, flat normals
 *  omitted (the CPU cutter and edge extractor only read positions/indices). */
function box(
  expressId: number,
  ifcType: string,
  geometryClass: number,
  min: [number, number, number],
  max: [number, number, number],
): MeshData {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const positions = new Float32Array([
    x0, y0, z0,  x1, y0, z0,  x1, y1, z0,  x0, y1, z0,
    x0, y0, z1,  x1, y0, z1,  x1, y1, z1,  x0, y1, z1,
  ]);
  const indices = new Uint32Array([
    0, 1, 2,  0, 2, 3, // -z
    4, 6, 5,  4, 7, 6, // +z
    0, 4, 5,  0, 5, 1, // -y
    3, 2, 6,  3, 6, 7, // +y
    0, 3, 7,  0, 7, 4, // -x
    1, 5, 6,  1, 6, 2, // +x
  ]);
  return {
    expressId,
    ifcType,
    modelIndex: 0,
    positions,
    normals: new Float32Array(positions.length),
    indices,
    color: [0.5, 0.5, 0.5, 1],
    geometryClass,
  };
}

const OCCURRENCE_ID = 100;
const TYPE_ID = 200;

function geometry(meshes: MeshData[], max: [number, number, number]): GeometryResult {
  return {
    meshes,
    totalTriangles: meshes.length * 12,
    totalVertices: meshes.length * 8,
    coordinateInfo: {
      originShift: { x: 0, y: 0, z: 0 },
      originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: max[0], y: max[1], z: max[2] } },
      shiftedBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: max[0], y: max[1], z: max[2] } },
      hasLargeCoordinates: false,
    },
  };
}

/** Drive the real hook once and return the drawing it publishes. */
async function generate(geometryResult: GeometryResult): Promise<Drawing2D | null> {
  let drawing: Drawing2D | null = null;
  let run: (() => Promise<void>) | null = null;

  function Harness(): null {
    const { generateDrawing } = useDrawingGeneration({
      activeTool: 'select',
      geometryResult,
      ifcDataStore: null,
      sectionPlane: { axis: 'down', position: 50, flipped: false },
      displayOptions: {
        showHiddenLines: false,
        useSymbolicRepresentations: false,
        show3DOverlay: false,
        scale: 50,
        showConstructionProjection: false,
      },
      combinedHiddenIds: new Set<number>(),
      combinedIsolatedIds: null,
      computedIsolatedIds: null,
      models: new Map([['m0', { id: 'm0', visible: true }]]),
      // Panel closed: the auto-generate effects stay out of the way so the
      // drawing under test is the one this harness asks for, not a race.
      panelVisible: false,
      // Every class visible: this suite is about the type-LIBRARY filter
      // (#2058), so the category filter (#2060) must not remove anything here.
      typeVisibility: {
        spaces: true,
        spatialZones: true,
        openings: true,
        virtualElements: true,
        site: true,
        ifcAnnotations: true,
      },
      drawing: null,
      setDrawing: (d) => { drawing = d; },
      setDrawingStatus: () => {},
      setDrawingProgress: () => {},
      setDrawingError: () => {},
    });
    run = generateDrawing;
    return null;
  }

  const container = document.createElement('div');
  document.body.appendChild(container);
  let root: Root | null = null;
  try {
    await act(async () => { root = createRoot(container); root.render(<Harness />); });
    assert.ok(run, 'harness never rendered — the hook was not called');
    await act(async () => { await run!(); });
    return drawing;
  } finally {
    if (root) await act(async () => { root!.unmount(); });
    container.remove();
  }
}

function entityIds(drawing: Drawing2D | null): Set<number> {
  const out = new Set<number>();
  for (const line of drawing?.lines ?? []) out.add(line.entityId);
  for (const poly of drawing?.cutPolygons ?? []) out.add(poly.entityId);
  return out;
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe('useDrawingGeneration type-library geometry (#2058)', () => {
  it('cuts the occurrence but not the instanced type template', async () => {
    const drawing = await generate(
      geometry(
        [
          box(OCCURRENCE_ID, 'IfcWall', 0, [0, 0, 0], [2, 3, 0.2]),
          box(TYPE_ID, 'IfcWallType', 2, [5, 0, 0], [7, 3, 0.2]),
        ],
        [7, 3, 0.2],
      ),
    );

    const ids = entityIds(drawing);
    // Negative case: the real building must still be drawn.
    assert.ok(
      ids.has(OCCURRENCE_ID),
      `occurrence geometry must still reach the 2D drawing; got ids ${[...ids]}`,
    );
    // The bug: the type template must not.
    assert.ok(
      !ids.has(TYPE_ID),
      `instanced type geometry must not reach the 2D drawing; got ids ${[...ids]}`,
    );
  });

  it('keeps orphan type geometry when the model has no occurrences at all', async () => {
    // A pure type-library file (buildingSMART annex-E) has nothing else to
    // draw — dropping class 1 unconditionally would blank the drawing, which
    // is exactly the trap `isMeshVisibleInViewMode` already encodes for 3D.
    const drawing = await generate(
      geometry([box(TYPE_ID, 'IfcBoilerType', 1, [0, 0, 0], [2, 3, 0.2])], [2, 3, 0.2]),
    );

    assert.ok(
      entityIds(drawing).has(TYPE_ID),
      'orphan type geometry must still be drawn for a model with no occurrences',
    );
  });

  it('drops orphan type geometry once the model has placed occurrences', async () => {
    const drawing = await generate(
      geometry(
        [
          box(OCCURRENCE_ID, 'IfcWall', 0, [0, 0, 0], [2, 3, 0.2]),
          box(TYPE_ID, 'IfcBoilerType', 1, [5, 0, 0], [7, 3, 0.2]),
        ],
        [7, 3, 0.2],
      ),
    );

    const ids = entityIds(drawing);
    assert.ok(ids.has(OCCURRENCE_ID), 'occurrence geometry must still be drawn');
    assert.ok(!ids.has(TYPE_ID), 'orphan type-library geometry must not be drawn alongside it');
  });
});

// Cold loads must not cut an invisible drawing merely because the user's
// persisted 3D-overlay preference is enabled. These exercise the real cutter.
type DrawingInputs = Omit<Parameters<typeof useDrawingGeneration>[0],
  'drawing' | 'setDrawing' | 'setDrawingStatus' | 'setDrawingProgress' | 'setDrawingError'>;

const OVERLAY_OPTIONS: DrawingInputs['displayOptions'] = {
  showHiddenLines: false, useSymbolicRepresentations: false, show3DOverlay: true,
  scale: 50, showConstructionProjection: false,
};

async function drawingActivityHarness(initial: Partial<DrawingInputs> = {}, strict = false) {
  let inputs: DrawingInputs = {
    geometryResult: null,
    ifcDataStore: null,
    sectionPlane: { axis: 'down', position: 50, flipped: false },
    displayOptions: OVERLAY_OPTIONS,
    typeVisibility: { spaces: true, spatialZones: true, openings: true, virtualElements: true, site: true, ifcAnnotations: true },
    combinedHiddenIds: new Set(), combinedIsolatedIds: null, computedIsolatedIds: null,
    models: new Map([['m0', { id: 'm0', visible: true }]]),
    panelVisible: false, activeTool: 'select',
    ...initial,
  };
  let published: Drawing2D | null = null;
  const publications: Set<number>[] = [];
  let starts = 0;
  let run: (() => Promise<void>) | undefined;
  const status = (value: string) => { if (value === 'generating') starts++; };
  const noop = () => {};
  function Harness({ value }: { value: DrawingInputs }) {
    const [drawing, setLocalDrawing] = useState<Drawing2D | null>(null);
    const publish = useCallback((next: Drawing2D | null) => {
      published = next;
      if (next) publications.push(entityIds(next));
      setLocalDrawing(next);
    }, []);
    const { generateDrawing } = useDrawingGeneration({
      ...value, drawing, setDrawing: publish, setDrawingStatus: status,
      setDrawingProgress: noop, setDrawingError: noop,
    });
    run = generateDrawing;
    return null;
  }
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const update = async (patch: Partial<DrawingInputs>) => {
    inputs = { ...inputs, ...patch };
    await act(async () => {
      const view = <Harness value={inputs} />;
      root.render(strict ? <StrictMode>{view}</StrictMode> : view);
    });
  };
  await update({});
  return {
    update,
    async activateSectionThenOpenPanel() {
      await act(async () => {
        inputs = { ...inputs, activeTool: 'section' };
        flushSync(() => root.render(<Harness value={inputs} />));
        assert.equal(starts, 1, 'section activation begins the real generation');
        assert.equal(published, null, 'exercise panel opening while generation is in flight');
        inputs = { ...inputs, panelVisible: true };
        flushSync(() => root.render(<Harness value={inputs} />));
        assert.equal(starts, 1, 'panel auto-opening must reuse the in-flight section drawing');
      });
    },
    async replaceGeometryInFlight() {
      await act(async () => {
        for (const id of [100, 200, 300]) {
          inputs = { ...inputs, geometryResult: activityGeometry(id), panelVisible: true };
          flushSync(() => root.render(<Harness value={inputs} />));
          assert.equal(starts, 1, 'PR #3921: geometry changes queue behind the running cut');
        }
      });
    },
    async replaceAfterCutStarted(started: Promise<void>, release: () => void) {
      await act(async () => {
        inputs = { ...inputs, geometryResult: activityGeometry(), panelVisible: true };
        flushSync(() => root.render(<Harness value={inputs} />));
        await started;
        try {
          inputs = { ...inputs, geometryResult: activityGeometry(400) };
          flushSync(() => root.render(<Harness value={inputs} />));
          assert.equal(starts, 1, 'new input must wait for the running generator');
        } finally { release(); }
      });
    },
    get publications() { return publications; },
    get drawing() { return published; },
    get starts() { return starts; },
    async generate() { await act(async () => { assert.ok(run); await run(); }); },
    async dispose() { await act(async () => root.unmount()); container.remove(); },
  };
}

function activityGeometry(firstId = 100) {
  return geometry([
    box(firstId, 'IfcWall', 0, [0, 0, 0], [2, 3, 0.2]),
    box(firstId + 1, 'IfcWall', 0, [4, 0, 0], [6, 3, 0.2]),
  ], [6, 3, 0.2]);
}

describe('useDrawingGeneration active drawing demand', () => {
  it('shares one generation when section activation auto-opens the panel', async () => {
    const h = await drawingActivityHarness();
    try {
      await h.update({ geometryResult: activityGeometry() });
      await h.activateSectionThenOpenPanel();
      assert.equal(h.starts, 1);
      assert.deepEqual(entityIds(h.drawing), new Set([100, 101]));
      await h.update({ panelVisible: false });
      await h.update({ panelVisible: true });
      assert.equal(h.starts, 1, 'opening a second consumer of the finished drawing also needs no duplicate');
      await h.update({ geometryResult: activityGeometry(200) });
      assert.equal(h.starts, 2, 'same-count geometry replacement remains a real input change');
      assert.deepEqual(entityIds(h.drawing), new Set([200, 201]));
    } finally { await h.dispose(); }
  });
  it('does no automatic cutting during a normal load with the overlay preference enabled', async () => {
    const h = await drawingActivityHarness();
    try {
      await h.update({ geometryResult: activityGeometry() });
      await h.update({ geometryResult: activityGeometry(200), sectionPlane: { axis: 'down', position: 25, flipped: false } });
      assert.equal(h.starts, 0, 'an invisible section must not begin generating');
      assert.equal(h.drawing, null);
      await h.generate();
      assert.equal(h.starts, 1, 'explicit generation/export remains available while hidden');
      assert.deepEqual(entityIds(h.drawing), new Set([200, 201]));
    } finally { await h.dispose(); }
  });

  it('generates when the panel opens even with the overlay disabled', async () => {
    const h = await drawingActivityHarness();
    try {
      await h.update({ geometryResult: activityGeometry(), displayOptions: { ...OVERLAY_OPTIONS, show3DOverlay: false } });
      assert.equal(h.starts, 0);
      await h.update({ panelVisible: true });
      assert.equal(h.starts, 1);
      assert.deepEqual(entityIds(h.drawing), new Set([100, 101]));
    } finally { await h.dispose(); }
  });

  it('generates for an active section overlay as geometry arrives and respects its toggle', async () => {
    const h = await drawingActivityHarness();
    try {
      await h.update({ activeTool: 'section' });
      assert.equal(h.starts, 0, 'section activation without geometry does no cutting');
      await h.update({ geometryResult: activityGeometry() });
      assert.equal(h.starts, 1);
      assert.deepEqual(entityIds(h.drawing), new Set([100, 101]));
      await h.update({ displayOptions: { ...OVERLAY_OPTIONS, show3DOverlay: false } });
      await h.update({ geometryResult: activityGeometry(200) });
      assert.equal(h.starts, 1, 'disabled overlay with closed panel does no cutting');
      await h.update({ displayOptions: OVERLAY_OPTIONS });
      assert.equal(h.starts, 2);
      assert.deepEqual(entityIds(h.drawing), new Set([200, 201]));
    } finally { await h.dispose(); }
  });

  for (const activation of ['panel', 'section'] as const) {
    it(`refreshes hidden input changes when the ${activation} becomes active again`, async () => {
      const h = await drawingActivityHarness();
      try {
        const on = activation === 'panel' ? { panelVisible: true } : { activeTool: 'section' };
        await h.update({ geometryResult: activityGeometry(), ...on });
        assert.deepEqual(entityIds(h.drawing), new Set([100, 101]));
        await h.update({ panelVisible: false, activeTool: 'select' });
        const starts = h.starts;
        await h.update({
          geometryResult: activityGeometry(300), // same mesh count, different model input
          combinedHiddenIds: new Set([300]),
          sectionPlane: { axis: 'down', position: 25, flipped: false },
        });
        assert.equal(h.starts, starts, 'hidden geometry changes must remain deferred');
        await h.update(on);
        assert.equal(h.starts, starts + 1);
        assert.deepEqual(entityIds(h.drawing), new Set([301]), 'activation must replace stale geometry and honor current visibility');
      } finally { await h.dispose(); }
    });
  }
});

// PR #3921 review: automatic geometry and filter changes must use current inputs.
describe('useDrawingGeneration latest inputs (#3921)', () => {
  it('serializes geometry replacements and coalesces them to the newest real cut', async () => {
    const h = await drawingActivityHarness();
    try {
      await h.replaceGeometryInFlight();
      assert.equal(h.starts, 2, 'only the running cut and newest replacement run');
      assert.deepEqual(entityIds(h.drawing), new Set([300, 301]));
    } finally { await h.dispose(); }
  });

  it('refreshes active hiding and both isolation inputs without moving the plane', async () => {
    const h = await drawingActivityHarness();
    try {
      await h.update({ geometryResult: activityGeometry(), panelVisible: true });
      await h.update({ combinedHiddenIds: new Set([100]) });
      assert.deepEqual(entityIds(h.drawing), new Set([101]));
      await h.update({ combinedHiddenIds: new Set(), combinedIsolatedIds: new Set([100]) });
      assert.deepEqual(entityIds(h.drawing), new Set([100]));
      await h.update({ combinedIsolatedIds: null, computedIsolatedIds: new Set([101]) });
      assert.deepEqual(entityIds(h.drawing), new Set([101]));
    } finally { await h.dispose(); }
  });
});

// Hold a REAL cutter result at its async boundary, rather than fabricating meshes.
it('never publishes a superseded cut that completes after replacement (#3921)', async () => {
  const original = Drawing2DGenerator.prototype.generate;
  let signal!: () => void;
  let release!: () => void;
  const started = new Promise<void>(resolve => { signal = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  Drawing2DGenerator.prototype.generate = async function (...args) {
    const first = ++calls === 1;
    const result = await original.call(this, ...args);
    if (first) { signal(); await held; }
    return result;
  };
  const h = await drawingActivityHarness();
  try {
    await h.replaceAfterCutStarted(started, release);
    assert.equal(calls, 2);
    assert.deepEqual(h.publications, [new Set([400, 401])], 'the completed old cut must not publish');
  } finally {
    release();
    Drawing2DGenerator.prototype.generate = original;
    await h.dispose();
  }
});

it('restarts active drawing demand after StrictMode effect cleanup (#3921)', async () => {
  const h = await drawingActivityHarness({ geometryResult: activityGeometry(), panelVisible: true }, true);
  try {
    assert.deepEqual(entityIds(h.drawing), new Set([100, 101]));
    assert.deepEqual(h.publications, [new Set([100, 101])]);
  } finally { await h.dispose(); }
});
