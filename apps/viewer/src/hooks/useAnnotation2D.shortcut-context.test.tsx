/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Delete / Backspace removes the selected 2D annotation only when focus is not
 * on an input-like surface (#5596). The hook kept its own INPUT/TEXTAREA-only
 * copy of that guard, so the key still deleted the annotation while a
 * `<select>` or a contenteditable host had focus. It now shares
 * `isTextEntryElement` with the other shortcut sites.
 */

import '@/test/setup-dom.js';

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useRef } from 'react';
import { render, cleanup, press } from '@/test/render.js';
import { useAnnotation2D } from './useAnnotation2D.js';

function Probe({ onDelete }: { onDelete: () => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  useAnnotation2D({
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
    setSelectedAnnotation2D: () => {},
    deleteSelectedAnnotation2D: onDelete,
    moveAnnotation2D: () => {},
    setAnnotation2DCursorPos: () => {},
    setMeasure2DSnapPoint: () => {},
  });
  return <div ref={containerRef} />;
}

describe('useAnnotation2D — Delete respects the focused widget (#5596)', () => {
  afterEach(() => {
    cleanup();
    document.body.replaceChildren();
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
});
