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
} from '@/store/slices/drawing2DSlice.js';

let handleMouseDown: ((e: React.MouseEvent) => boolean) | null = null;
let lastSelected: SelectedAnnotation2D | null | undefined;

interface ProbeProps {
  textAnnotations2D: TextAnnotation2D[];
  cloudAnnotations2D: CloudAnnotation2D[];
}

function Probe({ textAnnotations2D, cloudAnnotations2D }: ProbeProps) {
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
    measure2DResults: [],
    polygonArea2DResults: [],
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
});
