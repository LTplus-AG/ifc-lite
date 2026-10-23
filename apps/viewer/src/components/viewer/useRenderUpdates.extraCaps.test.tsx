/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What the renderer is handed for the caps of the cutting planes beyond the
 * active one (#7545): each enabled inactive plane's cap, under its own plane id,
 * only while the Section tool shows the 3D cut, and never one that was cut for a
 * plane position the plane has since left.
 */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act, useRef } from 'react';
import type { Renderer, VisualEnhancementOptions } from '@ifc-lite/renderer';
import type { Drawing2D } from '@ifc-lite/drawing-2d';
import { cleanup, render } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { capSignature } from '@/lib/section/section-cut-config';
import { useRenderUpdates } from './useRenderUpdates.js';

const state = () => useViewerStore.getState();

interface Upload { axis: string; position: number; flipped: boolean; planeId?: string; polygons: number; range?: { min: number; max: number } }

function recordingRenderer() {
  const uploads: Upload[] = [];
  const kept: string[][] = [];
  const cleared: (string | undefined)[] = [];
  const target = {
    uploadSection2DOverlay: (polygons: unknown[], _l: unknown, axis: string, position: number, range: Upload['range'], flipped: boolean, _c: unknown, planeId?: string) =>
      uploads.push({ axis, position, flipped, planeId, polygons: polygons.length, range }),
    clearSection2DExtraOverlays: (keep: string[]) => kept.push([...keep]),
    clearSection2DOverlay: (id?: string) => cleared.push(id),
  };
  const renderer = new Proxy(target, { get: (t, key) => (t as Record<string | symbol, unknown>)[key] ?? (() => {}) });
  return { uploads, kept, cleared, renderer: renderer as unknown as Renderer };
}

/** The model's bounds in the renderer's Y-up space: X 18 m wide, Y (up) 7.3 m, Z 18 m. */
const BOUNDS = { min: { x: -3, y: -1, z: -13 }, max: { x: 15, y: 6.3, z: 5 } };

function Probe({ renderer, bounds }: { renderer: Renderer; bounds?: typeof BOUNDS }) {
  const ref = <T,>(v: T) => useRef(v);
  const s = useViewerStore();
  useRenderUpdates({
    rendererRef: ref<Renderer | null>(renderer), isInitialized: true, theme: 'light',
    clearColorRef: ref<[number, number, number, number]>([0, 0, 0, 1]),
    visualEnhancementRef: ref({} as VisualEnhancementOptions),
    hiddenEntities: new Set(), isolatedEntities: null, ghostExceptEntities: null,
    selectedEntityId: null, selectedEntityIds: undefined, selectedModelIndex: undefined,
    activeTool: s.activeTool, sectionPlane: s.sectionPlane, sectionRange: null,
    hiddenEntitiesRef: ref(new Set<number>()), isolatedEntitiesRef: ref<Set<number> | null>(null),
    selectedEntityIdRef: ref<number | null>(null), selectedModelIndexRef: ref<number | undefined>(undefined),
    selectedEntityIdsRef: ref<Set<number> | undefined>(undefined), sectionPlaneRef: ref(s.sectionPlane),
    // The ACTIVE plane's range: along the active plane's axis, not the other planes'.
    sectionRangeRef: ref<{ min: number; max: number } | null>(bounds ? { min: BOUNDS.min.y, max: BOUNDS.max.y } : null),
    sectionBoundsRef: ref(bounds ?? null), activeToolRef: ref(s.activeTool),
    drawing2D: s.drawing2D, show3DOverlay: s.drawing2DDisplayOptions.show3DOverlay, showHiddenLines: false,
  });
  return null;
}

const POLYGON = { polygon: { outer: [], holes: [] }, ifcType: 'IfcWall', entityId: 1 } as never;

/** A (active, down) and B (front), B inactive. Returns B's id. */
function twoPlanes(): string {
  state().setActiveTool('section');
  state().addSectionPlane('down');
  const b = state().addSectionPlane('front')!;
  state().activateSectionPlane(state().inactiveSectionPlanes[0].id);
  return b;
}
const cutFor = (id: string) => {
  const plane = state().inactiveSectionPlanes.find((p) => p.id === id)!;
  state().setSectionExtraCap(id, { signature: `1:${capSignature(plane)}`, cutPolygons: [POLYGON], lines: [] });
};

beforeEach(() => state().resetViewerState());
afterEach(cleanup);

describe('the other cutting planes\' caps reach the renderer (#7545)', () => {
  it('uploads a plane\'s cap under its own id, at its own position', () => {
    const b = twoPlanes();
    const { uploads, renderer } = recordingRenderer();
    render(<Probe renderer={renderer} />);
    act(() => cutFor(b));

    const upload = uploads.find((u) => u.planeId === b);
    assert.ok(upload, 'B\'s cap was uploaded');
    assert.equal(upload.axis, 'front');
    assert.equal(upload.position, state().inactiveSectionPlanes[0].position);
    assert.equal(upload.polygons, 1);
  });

  it('places a plane\'s cap over the plane\'s OWN axis, not the active plane\'s', () => {
    const b = twoPlanes(); // A (down, active: range along Y), B (front, inactive: range along Z)
    const { uploads, renderer } = recordingRenderer();
    render(<Probe renderer={renderer} bounds={BOUNDS} />);
    act(() => cutFor(b));

    assert.deepEqual(uploads.find((u) => u.planeId === b)!.range, { min: BOUNDS.min.z, max: BOUNDS.max.z },
      'B\'s 50 % is the middle of the model\'s depth; over the active plane\'s height it would land 4 m off');
  });

  it('leaves the range to the renderer while the model\'s bounds are unknown', () => {
    const b = twoPlanes();
    const { uploads, renderer } = recordingRenderer();
    render(<Probe renderer={renderer} />);
    act(() => cutFor(b));
    assert.equal(uploads.find((u) => u.planeId === b)!.range, undefined);
  });

  it('keeps only the enabled inactive planes\' caps in the renderer', () => {
    const b = twoPlanes();
    const { kept, renderer } = recordingRenderer();
    render(<Probe renderer={renderer} />);
    assert.deepEqual(kept.at(-1), [b]);

    act(() => state().setSectionPlaneCutting(b, false));
    assert.deepEqual(kept.at(-1), [], 'a plane whose Cut is off keeps no cap');

    act(() => state().setActiveTool('select'));
    assert.deepEqual(kept.at(-1), [], 'nor does anything outside the Section tool');
  });

  it('does not lift a cap onto a plane position it was not cut for', () => {
    const b = twoPlanes();
    const { uploads, renderer } = recordingRenderer();
    render(<Probe renderer={renderer} />);
    act(() => cutFor(b));
    const before = uploads.length;

    // B moves; its parked cap still belongs to the old position.
    act(() => {
      state().activateSectionPlane(b);
      state().setSectionPlanePosition(80);
      state().activateSectionPlane(state().inactiveSectionPlanes[0].id);
    });
    assert.equal(uploads.slice(before).filter((u) => u.planeId === b).length, 0, 'the stale cap is not uploaded');

    act(() => cutFor(b));
    assert.equal(uploads.at(-1)!.planeId, b);
    assert.equal(uploads.at(-1)!.position, 80, 'the fresh cap is');
  });

  it('the previous plane\'s drawing is not lifted onto the plane that just became active', () => {
    const b = twoPlanes(); // A active, B inactive
    const { uploads, cleared, renderer } = recordingRenderer();
    render(<Probe renderer={renderer} />);
    const drawing = { cutPolygons: [POLYGON], lines: [], bounds: {}, config: {} } as unknown as Drawing2D;
    act(() => useViewerStore.setState({ drawing2D: drawing }));
    const primaryUploads = () => uploads.filter((u) => u.planeId === undefined);
    assert.equal(primaryUploads().length, 1, 'the drawing of the active plane is drawn');

    // B is chosen; the drawing is still A's until the new cut arrives.
    act(() => state().activateSectionPlane(b));
    assert.equal(primaryUploads().length, 1, 'A\'s polygons are not uploaded again onto B');
    assert.ok(cleared.includes(undefined), 'and the primary cap is cleared instead of left on the wrong plane');

    // B's own drawing arrives and is drawn.
    act(() => useViewerStore.setState({ drawing2D: { ...drawing } as Drawing2D }));
    assert.equal(primaryUploads().length, 2);
    assert.equal(primaryUploads()[1]!.axis, state().sectionPlane.axis);

    // Editing the SAME plane keeps its cap following it while the cut catches up.
    act(() => state().setSectionPlanePosition(80));
    assert.equal(primaryUploads().length, 3);
    assert.equal(primaryUploads()[2]!.position, 80);
  });

  it('a plane with an empty cut clears its cap instead of drawing nothing over the old one', () => {
    const b = twoPlanes();
    const { cleared, renderer } = recordingRenderer();
    render(<Probe renderer={renderer} />);
    const plane = state().inactiveSectionPlanes[0];
    act(() => state().setSectionExtraCap(b, { signature: `1:${capSignature(plane)}`, cutPolygons: [], lines: [] }));
    assert.ok(cleared.includes(b));
  });
});
