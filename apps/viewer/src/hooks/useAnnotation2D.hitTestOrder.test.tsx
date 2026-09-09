/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Coverage for #4195: `hitTestAnnotations` (in `useAnnotation2D.ts`) must
 * pick the annotation that is visually ON TOP, not the first match in a
 * fixed type/insertion order.
 *
 * `Drawing2DCanvas.tsx` paints, in order, measure -> polygon -> text ->
 * cloud, each loop forward, so the LAST item of a type (and cloud as a
 * type) ends up drawn on top. Before this fix, `hitTestAnnotations` checked
 * text -> cloud -> polygon -> measure, each array walked forward, and
 * returned on the first match — the OLDEST item of the first matching type,
 * which is frequently the item furthest from the viewer, not the one on
 * top.
 *
 * `useAnnotation2D.ts` had no test file before this one; this file mounts
 * the hook directly via a `Probe` component (the same pattern used by
 * `useSandbox.teardownAbort.test.tsx` and friends), since the hook takes
 * explicit props rather than reading a store.
 */

import '@/test/setup-dom.js';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useRef } from 'react';
import { useAnnotation2D } from './useAnnotation2D.js';
import type {
  SelectedAnnotation2D, TextAnnotation2D, CloudAnnotation2D,
  Measure2DResult, PolygonArea2DResult,
} from '@/store/slices/drawing2DSlice.js';

let handleMouseDown: ((e: React.MouseEvent) => boolean) | null = null;
let lastSelected: SelectedAnnotation2D | null | undefined;

interface ProbeProps {
  textAnnotations2D: TextAnnotation2D[];
  cloudAnnotations2D: CloudAnnotation2D[];
  measure2DResults?: Measure2DResult[];
  polygonArea2DResults?: PolygonArea2DResult[];
}

function Probe({
  textAnnotations2D, cloudAnnotations2D,
  measure2DResults = [], polygonArea2DResults = [],
}: ProbeProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const result = useAnnotation2D({
    drawing: null,
    viewTransform: { x: 0, y: 0, scale: 1 },
    sectionAxis: 'down',
    containerRef,
    activeTool: 'none',
    setActiveTool: () => {},
    polygonArea2DPoints: [],
    addPolygonArea2DPoint: () => {},
    completePolygonArea2D: () => {},
    cancelPolygonArea2D: () => {},
    textAnnotations2D,
    addTextAnnotation2D: () => {},
    setTextAnnotation2DEditing: () => {},
    cloudAnnotation2DPoints: [],
    cloudAnnotations2D,
    addCloudAnnotation2DPoint: () => {},
    completeCloudAnnotation2D: () => {},
    cancelCloudAnnotation2D: () => {},
    measure2DResults,
    polygonArea2DResults,
    selectedAnnotation2D: null,
    setSelectedAnnotation2D: (sel) => { lastSelected = sel; },
    deleteSelectedAnnotation2D: () => {},
    moveAnnotation2D: () => {},
    setAnnotation2DCursorPos: () => {},
    setMeasure2DSnapPoint: () => {},
  });
  handleMouseDown = result.handleMouseDown;
  return <div ref={containerRef} />;
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function mount(props: ProbeProps) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<Probe {...props} />);
  });
}

function unmount() {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  handleMouseDown = null;
  lastSelected = undefined;
}

function click(x: number, y: number): boolean {
  // viewTransform is identity (scale 1, origin 0,0) with sectionAxis 'down',
  // so drawing coords === screen coords here — clientX/Y map 1:1.
  const consumed = handleMouseDown!({
    button: 0,
    clientX: x,
    clientY: y,
  } as unknown as React.MouseEvent);
  return consumed;
}

after(() => {
  unmount();
});

describe('useAnnotation2D hitTestAnnotations — top-most wins (#4195)', () => {
  it('same-type overlap: the newer (topmost) cloud is selected, not the older one', () => {
    // Cloud "old" is drawn first; cloud "new" is drawn after and overlaps
    // it, so "new" is on top per Drawing2DCanvas paint order.
    const clouds: CloudAnnotation2D[] = [
      { id: 'cloud-old', points: [{ x: 0, y: 0 }, { x: 10, y: 10 }], color: '#E53935', label: '' },
      { id: 'cloud-new', points: [{ x: 2, y: 2 }, { x: 12, y: 12 }], color: '#E53935', label: '' },
    ];
    mount({ textAnnotations2D: [], cloudAnnotations2D: clouds });

    act(() => { click(5, 5); });

    assert.equal(lastSelected?.type, 'cloud');
    assert.equal(
      lastSelected?.id,
      'cloud-new',
      `expected the topmost (newer) cloud to be selected, got ${JSON.stringify(lastSelected)}`,
    );

    unmount();
  });

  it('cross-type overlap: a cloud drawn over a text box selects the cloud, not the hidden text', () => {
    // Text is drawn first (paint order: measure -> polygon -> text -> cloud),
    // then a cloud is added afterward that overlaps it, so the cloud is on
    // top and should win the hit test even though text was checked "first"
    // under the old fixed type order.
    const texts: TextAnnotation2D[] = [
      {
        id: 'text-1',
        position: { x: 0, y: 0 },
        text: 'X',
        fontSize: 14,
        color: '#000000',
        backgroundColor: 'rgba(255,255,255,0.9)',
        borderColor: '#333333',
      },
    ];
    const clouds: CloudAnnotation2D[] = [
      { id: 'cloud-over-text', points: [{ x: 5, y: 5 }, { x: 20, y: 20 }], color: '#E53935', label: '' },
    ];
    mount({ textAnnotations2D: texts, cloudAnnotations2D: clouds });

    act(() => { click(10, 10); });

    assert.equal(
      lastSelected?.type,
      'cloud',
      `expected the topmost cloud to win over the hidden text, got ${JSON.stringify(lastSelected)}`,
    );
    assert.equal(lastSelected?.id, 'cloud-over-text');

    unmount();
  });

  it('same-type overlap: the newer (topmost) text box is selected, not the older one', () => {
    // Text bounding box is computed from position (top-left), fontSize and
    // text length. "old" sits at (0,0), "new" is drawn after and its box
    // overlaps "old"'s box, so a click inside the overlap must hit "new"
    // first when the text array is walked backwards.
    const texts: TextAnnotation2D[] = [
      {
        id: 'text-old',
        position: { x: 0, y: 0 },
        text: 'A',
        fontSize: 14,
        color: '#000000',
        backgroundColor: 'rgba(255,255,255,0.9)',
        borderColor: '#333333',
      },
      {
        id: 'text-new',
        position: { x: 2, y: 2 },
        text: 'B',
        fontSize: 14,
        color: '#000000',
        backgroundColor: 'rgba(255,255,255,0.9)',
        borderColor: '#333333',
      },
    ];
    mount({ textAnnotations2D: texts, cloudAnnotations2D: [] });

    // Sanity: the click point must genuinely fall inside BOTH boxes, or
    // this would pass vacuously regardless of iteration order.
    // old box (fontSize 14, 1-char line): x:[-2,22.4] y:[-2,32.2]
    // new box: x:[0,24.4] y:[0,34.2]
    // (10,10) is inside both.
    act(() => { click(10, 10); });

    assert.equal(lastSelected?.type, 'text');
    assert.equal(
      lastSelected?.id,
      'text-new',
      `expected the topmost (newer) text box to be selected, got ${JSON.stringify(lastSelected)}`,
    );

    unmount();
  });

  it('same-type overlap: the newer (topmost) polygon is selected via edge proximity, not the older one', () => {
    // Polygon hit-testing is edge-proximity (within HIT_TEST_RADIUS_PX=10)
    // or the centroid label box — NOT a bounding-box test. Both polygons
    // below have a near-horizontal edge passing within 10px of the click
    // point (10,10), so the click is a genuine edge-proximity hit on BOTH,
    // not merely a visual overlap.
    const polys: PolygonArea2DResult[] = [
      {
        id: 'poly-old',
        // Edge (-5,8)->(25,8): nearest point to (10,10) is (10,8), dist=2 < 10.
        points: [{ x: -5, y: 8 }, { x: 25, y: 8 }, { x: 25, y: 30 }, { x: -5, y: 30 }],
        area: 1,
        perimeter: 1,
      },
      {
        id: 'poly-new',
        // Edge (-5,12)->(25,12): nearest point to (10,10) is (10,12), dist=2 < 10.
        points: [{ x: -5, y: 12 }, { x: 25, y: 12 }, { x: 25, y: 30 }, { x: -5, y: 30 }],
        area: 1,
        perimeter: 1,
      },
    ];
    mount({
      textAnnotations2D: [], cloudAnnotations2D: [], polygonArea2DResults: polys,
    });

    act(() => { click(10, 10); });

    assert.equal(lastSelected?.type, 'polygon');
    assert.equal(
      lastSelected?.id,
      'poly-new',
      `expected the topmost (newer) polygon to be selected via edge proximity, got ${JSON.stringify(lastSelected)}`,
    );

    unmount();
  });

  it('same-type overlap: the newer (topmost) measure is selected via line proximity, not the older one', () => {
    // Measure hit-testing is line-segment proximity (within
    // HIT_TEST_RADIUS_PX=10), not a bounding-box test. Both segments below
    // pass within 10px of the click point (10,5), a genuine proximity hit
    // on BOTH, not merely a visual overlap.
    const measures: Measure2DResult[] = [
      {
        id: 'measure-old',
        // Horizontal segment at y=0: nearest point to (10,5) is (10,0), dist=5 < 10.
        start: { x: 0, y: 0 },
        end: { x: 20, y: 0 },
        distance: 20,
      },
      {
        id: 'measure-new',
        // Horizontal segment at y=8: nearest point to (10,5) is (10,8), dist=3 < 10.
        start: { x: 0, y: 8 },
        end: { x: 20, y: 8 },
        distance: 20,
      },
    ];
    mount({
      textAnnotations2D: [], cloudAnnotations2D: [], measure2DResults: measures,
    });

    act(() => { click(10, 5); });

    assert.equal(lastSelected?.type, 'measure');
    assert.equal(
      lastSelected?.id,
      'measure-new',
      `expected the topmost (newer) measure to be selected via line proximity, got ${JSON.stringify(lastSelected)}`,
    );

    unmount();
  });
});
