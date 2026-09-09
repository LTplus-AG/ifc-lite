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
import { after, describe, it } from 'node:test';
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
    // or the centroid label box — NOT a bounding-box test. This must
    // actually exercise the edge-proximity (pass 2) path, not the
    // centroid-label box (pass 1) — pass 1 always wins over pass 2, so if
    // a polygon's naive centroid (computePolygonCentroid: plain vertex
    // average, not the area-weighted centroid) happens to land inside the
    // fixed 40x20 centroid-label box around the click, pass 1 resolves the
    // hit and pass 2's edge-proximity code never runs at all, regardless
    // of which polygon "should" win by edge distance.
    //
    // Both polygons here are tall (top edge near the click, far bottom
    // edge) specifically so their naive centroid sits far below the click
    // (dy > 20) and cannot satisfy the pass-1 centroid box, forcing
    // resolution through pass 2. Both have a near-horizontal top edge
    // passing within 10px of the click point (10,10), at an EQUAL
    // distance (2px) from each other, so the pick can only be explained by
    // pass 2's reverse (topmost-first) iteration order — not by a distance
    // tiebreak in either polygon's favour.
    const polys: PolygonArea2DResult[] = [
      {
        id: 'poly-old',
        // Edge (-5,8)->(25,8): nearest point to (10,10) is (10,8), dist=2 < 10.
        // Centroid (naive avg of the 4 vertices): (10, 354) — dy=344 from
        // click, well outside the pass-1 centroid box (dy < 20 required).
        points: [{ x: -5, y: 8 }, { x: 25, y: 8 }, { x: 25, y: 700 }, { x: -5, y: 700 }],
        area: 1,
        perimeter: 1,
      },
      {
        id: 'poly-new',
        // Edge (-5,12)->(25,12): nearest point to (10,10) is (10,12), dist=2 < 10.
        // Centroid: (10, 356) — dy=346 from click, also outside the box.
        points: [{ x: -5, y: 12 }, { x: 25, y: 12 }, { x: 25, y: 700 }, { x: -5, y: 700 }],
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
    // on BOTH — and at an EQUAL distance (4px) from each other, so the pick
    // can only be explained by pass 2's reverse (topmost-first) iteration
    // order, not by a distance tiebreak in either measure's favour. If pass
    // 2 iterated forward instead, distance alone would still decide the
    // winner here and this test would not catch the regression.
    const measures: Measure2DResult[] = [
      {
        id: 'measure-old',
        // Horizontal segment at y=1: nearest point to (10,5) is (10,1), dist=4 < 10.
        start: { x: 0, y: 1 },
        end: { x: 20, y: 1 },
        distance: 20,
      },
      {
        id: 'measure-new',
        // Horizontal segment at y=9: nearest point to (10,5) is (10,9), dist=4 < 10.
        start: { x: 0, y: 9 },
        end: { x: 20, y: 9 },
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

  it('padded miss does not beat a real hit: a cloud\'s click-tolerance padding must not steal a click that is genuinely inside a neighbouring text box and outside the cloud\'s drawn extent (#4198)', () => {
    // Cloud rect (0,0)-(10,10) draws over x:[0,10], y:[0,10]. Cloud
    // hit-testing pads that bbox by HIT_TEST_RADIUS_PX=10px for click
    // tolerance, extending the padded hit rect to x:[-10,20], y:[-10,20].
    // Text sits at (12,0), 'X', fontSize 14: box ~= x:[10,34.4], y:[-2,32.2].
    // The click at (18,5) is 8px outside the cloud's drawn edge (not a
    // genuine cloud hit — only a padding hit) but genuinely inside the
    // text box. The cloud is checked first (topmost paint order), so a
    // first-match-by-type scan would wrongly return the cloud.
    const clouds: CloudAnnotation2D[] = [
      { id: 'cloud-1', points: [{ x: 0, y: 0 }, { x: 10, y: 10 }], color: '#E53935', label: '' },
    ];
    const texts: TextAnnotation2D[] = [
      {
        id: 'text-1',
        position: { x: 12, y: 0 },
        text: 'X',
        fontSize: 14,
        color: '#000000',
        backgroundColor: 'rgba(255,255,255,0.9)',
        borderColor: '#333333',
      },
    ];
    mount({ textAnnotations2D: texts, cloudAnnotations2D: clouds });

    act(() => { click(18, 5); });

    assert.equal(
      lastSelected?.type,
      'text',
      `expected the genuine text hit to win over the cloud's padding-only hit, got ${JSON.stringify(lastSelected)}`,
    );
    assert.equal(lastSelected?.id, 'text-1');

    unmount();
  });

  it('pass 2 genuine cross-type competition: nearest padded candidate wins, not the first-iterated type (#4198)', () => {
    // Every other test either never reaches pass 2 (masked by a pass-1
    // genuine hit) or has only one type present, so "first candidate"
    // trivially equals "nearest candidate" and a first-wins bug is
    // invisible. This test puts two DIFFERENT types in pass 2 at
    // deliberately unequal distances, with the FARTHER one iterated
    // FIRST, so only genuine nearest-distance resolution can produce the
    // expected answer.
    //
    // Pass-2 iteration order is cloud -> polygon -> measure (each
    // reversed), so a cloud is always checked before a measure. Click at
    // (10, 18):
    //  - Cloud rect (0,0)-(10,10): the click's x=10 is inside the bbox's
    //    x-range [0,10] (dx=0), but y=18 is 8px below the bbox's y-range
    //    [0,10] (dy=8), so padded distance = 8 (< HIT_TEST_RADIUS_PX=10 =>
    //    a pass-2 candidate) and it is NOT a pass-1 genuine hit (y=18 is
    //    outside [0,10]).
    //  - Measure segment (0,17)-(20,17): nearest point to (10,18) is
    //    (10,17), distance = 1 (< 10 => also a pass-2 candidate).
    // No text and no polygon are present, so pass 1 has nothing to match
    // and cannot mask this. The measure (dist=1) is genuinely nearer than
    // the cloud (dist=8) despite being iterated second — the correct
    // "nearest wins" resolution must return the measure. A "first
    // candidate wins" bug would return the cloud instead, since clouds are
    // always checked before measures.
    const clouds: CloudAnnotation2D[] = [
      { id: 'cloud-far', points: [{ x: 0, y: 0 }, { x: 10, y: 10 }], color: '#E53935', label: '' },
    ];
    const measures: Measure2DResult[] = [
      { id: 'measure-near', start: { x: 0, y: 17 }, end: { x: 20, y: 17 }, distance: 20 },
    ];
    mount({
      textAnnotations2D: [], cloudAnnotations2D: clouds, measure2DResults: measures,
    });

    act(() => { click(10, 18); });

    assert.equal(
      lastSelected?.type,
      'measure',
      `expected the genuinely nearer measure (dist=1) to beat the farther, first-iterated cloud (dist=8), got ${JSON.stringify(lastSelected)}`,
    );
    assert.equal(lastSelected?.id, 'measure-near');

    unmount();
  });
});
