/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Delete / Backspace respects focused editing widgets (#5596). The drawing's
 * Escape handler also takes priority over the global viewer action (#5841).
 */

import '@/test/setup-dom.js';

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act, useRef } from 'react';
import { render, cleanup, press } from '@/test/render.js';
import { registerKeyboardCommand } from '@/lib/commands/dispatcher';
import { useViewerStore } from '@/store';
import { useAnnotation2D } from './useAnnotation2D.js';
import { useMeasure2D } from './useMeasure2D.js';
import { useSpaceSketchKeys } from '@/components/viewer/tools/space-sketch/useSpaceSketchKeys.js';

const originalViewportTool = useViewerStore.getState().activeTool;

function Probe({ onDelete, onDeselect = () => {}, activeTool = 'none' }: {
  onDelete: () => void; onDeselect?: () => void; activeTool?: 'none' | 'measure';
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  useAnnotation2D({
    drawing: null,
    viewTransform: { x: 0, y: 0, scale: 1 },
    sectionAxis: 'down',
    containerRef,
    activeTool,
    setActiveTool: (tool) => { useViewerStore.getState().setAnnotation2DActiveTool(tool); },
    polygonArea2DPoints: [],
    addPolygonArea2DPoint: () => {},
    completePolygonArea2D: () => {},
    cancelPolygonArea2D: () => {},
    textAnnotations2D: [],
    addTextAnnotation2D: () => {},
    setTextAnnotation2DEditing: () => {},
    cloudAnnotation2DPoints: [],
    cloudAnnotations2D: [],
    addCloudAnnotation2DPoint: () => {},
    completeCloudAnnotation2D: () => {},
    cancelCloudAnnotation2D: () => {},
    measure2DResults: [],
    polygonArea2DResults: [],
    selectedAnnotation2D: { type: 'text', id: 't1' },
    setSelectedAnnotation2D: (selection) => { if (selection === null) onDeselect(); },
    deleteSelectedAnnotation2D: onDelete,
    moveAnnotation2D: () => {},
    setAnnotation2DCursorPos: () => {},
    setMeasure2DSnapPoint: () => {},
  });
  return <div ref={containerRef} />;
}

function MeasureProbe({ onCancel }: { onCancel: () => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const measure2DStart = useViewerStore((state) => state.measure2DStart);
  const measure2DCurrent = useViewerStore((state) => state.measure2DCurrent);
  useMeasure2D({
    drawing: null, viewTransform: { x: 0, y: 0, scale: 1 }, setViewTransform: () => {},
    sectionAxis: 'down', containerRef, measure2DMode: true,
    measure2DStart, measure2DCurrent, measure2DShiftLocked: false,
    measure2DLockedAxis: null, setMeasure2DStart: () => {}, setMeasure2DCurrent: () => {},
    setMeasure2DShiftLocked: () => {}, setMeasure2DSnapPoint: () => {},
    cancelMeasure2D: onCancel, completeMeasure2D: () => {},
  });
  return <div ref={containerRef} />;
}

function SketchProbe({ onAbort }: { onAbort: () => void }) {
  useSpaceSketchKeys({
    undo: () => {}, redo: () => {}, closePopovers: () => false,
    abortCurrentOp: () => { onAbort(); return true; }, closeNow: () => {},
    needsConfirm: false, setStatus: () => {}, commitDraw: null, onModifiers: () => {},
  });
  return null;
}

describe('useAnnotation2D — Delete respects the focused widget (#5596)', () => {
  afterEach(() => {
    cleanup();
    document.body.replaceChildren();
    useViewerStore.getState().setAnnotation2DActiveTool('none');
    useViewerStore.setState({ activeTool: originalViewportTool });
  });

  it('Delete with nothing focused removes the selected annotation (control)', () => {
    let deletes = 0;
    render(<Probe onDelete={() => { deletes++; }} />);
    press(window, 'Delete');
    assert.equal(deletes, 1);
  });

  it('Delete / Backspace in a focused <select> or contenteditable host keeps the annotation', () => {
    let deletes = 0;
    render(<Probe onDelete={() => { deletes++; }} />);

    const select = document.createElement('select');
    document.body.appendChild(select);
    select.focus();
    press(select, 'Delete');

    const editable = document.createElement('div');
    editable.contentEditable = 'true';
    editable.tabIndex = 0;
    document.body.appendChild(editable);
    editable.focus();
    press(editable, 'Backspace');

    assert.equal(deletes, 0);
  });

  it('#5841 Escape clears the drawing selection before the global viewer action', () => {
    let deselections = 0;
    let globalEscapes = 0;
    const unregister = registerKeyboardCommand('selection.escape', () => { globalEscapes++; });
    try {
      render(<Probe onDelete={() => {}} onDeselect={() => { deselections++; }} />);
      press(window, 'Escape');
      assert.equal(deselections, 1);
      assert.equal(globalEscapes, 0);
    } finally {
      unregister();
    }
  });

  it('#5841 Escape cancels measurement and exits its active drawing tool', () => {
    useViewerStore.getState().setAnnotation2DActiveTool('measure');
    let cancellations = 0;
    let globalEscapes = 0;
    const unregister = registerKeyboardCommand('selection.escape', () => { globalEscapes++; });
    try {
      render(<MeasureProbe onCancel={() => { cancellations++; }} />);
      press(window, 'Escape');
      assert.equal(cancellations, 1, 'the in-progress measurement is cancelled');
      assert.equal(useViewerStore.getState().annotation2DActiveTool, 'none', 'the drawing tool exits');
      assert.equal(globalEscapes, 0, 'Escape is owned by the drawing');
    } finally {
      unregister();
    }
  });

  it('#5841 Escape cancels measurement with both drawing hooks mounted', () => {
    useViewerStore.getState().setAnnotation2DActiveTool('measure');
    let cancellations = 0;
    render(<><MeasureProbe onCancel={() => { cancellations++; }} /><Probe activeTool="measure" onDelete={() => {}} /></>);
    press(window, 'Escape');
    assert.equal(cancellations, 1, 'the in-progress measurement is cancelled once');
    assert.equal(useViewerStore.getState().annotation2DActiveTool, 'none', 'the markup tool exits');
  });

  it('#5841 in-progress measurement still owns Escape after its state re-registers', () => {
    useViewerStore.getState().setAnnotation2DActiveTool('measure');
    let cancellations = 0;
    render(<><MeasureProbe onCancel={() => { cancellations++; }} /><Probe activeTool="measure" onDelete={() => {}} /></>);
    act(() => {
      useViewerStore.getState().setMeasure2DStart({ x: 1, y: 2 });
      useViewerStore.getState().setMeasure2DCurrent({ x: 3, y: 4 });
    });
    press(window, 'Escape');
    assert.equal(cancellations, 1, 'measurement cancellation outranks the persistent annotation binding');
    assert.equal(useViewerStore.getState().annotation2DActiveTool, 'none');
    assert.equal(useViewerStore.getState().measure2DStart, null);
  });

  it('#5841 Space Sketch aborts before a persisted drawing selection clears', () => {
    useViewerStore.setState({ activeTool: 'spaceSketch' });
    let deselections = 0;
    let aborts = 0;
    render(<><Probe onDelete={() => {}} onDeselect={() => { deselections++; }} />
      <SketchProbe onAbort={() => { aborts++; }} /></>);
    press(window, 'Escape');
    assert.equal(aborts, 1, 'the active overlay owns its first Escape');
    assert.equal(deselections, 0, 'the background drawing selection remains intact');
  });
});
