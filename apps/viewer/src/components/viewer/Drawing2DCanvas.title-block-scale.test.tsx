/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #11581: the sheet preview drew the title block's stored "Scale" text while
 * the export (#11458) prints the scale the drawing is placed at. A sheet at
 * 1:50 whose stored field still reads "1:100" previewed "1:100" and exported
 * "1:50". The preview now runs the same `titleBlockWithEffectiveScale`.
 */

import '@/test/setup-dom.js';
import { installLayout } from '@/test/dom-layout.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  GraphicOverrideEngine, PAPER_SIZE_REGISTRY, FRAME_PRESETS, TITLE_BLOCK_PRESETS,
  DEFAULT_TITLE_BLOCK_FIELDS, DEFAULT_SCALE_BAR, DEFAULT_NORTH_ARROW, calculateViewportBounds,
} from '@ifc-lite/drawing-2d';
import type { Drawing2D, DrawingSheet } from '@ifc-lite/drawing-2d';
import { Drawing2DCanvas } from './Drawing2DCanvas.js';
import type { CachedSheetTransform } from '@/lib/drawing/sheet-geometry-key.js';

installLayout();

/** Records every `fillText` string the canvas draws. */
function installCanvasStub(): { texts: string[]; restore: () => void } {
  const texts: string[] = [];
  const ctx = new Proxy({}, {
    get(_target, prop) {
      if (prop === 'measureText') return (text: string) => ({ width: String(text).length * 7 });
      if (prop === 'canvas') return { width: 800, height: 600 };
      return (...args: unknown[]) => { if (prop === 'fillText') texts.push(String(args[0])); };
    },
    set() { return true; },
  }) as unknown as CanvasRenderingContext2D;
  const original = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = ((kind: string) =>
    kind === '2d' ? ctx : null) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  return { texts, restore: () => { HTMLCanvasElement.prototype.getContext = original; } };
}

function drawingSpanning(widthM: number): Drawing2D {
  return {
    config: { plane: { axis: 'y', position: 0, flipped: false }, projectionDepth: 10, includeHiddenLines: true, creaseAngle: 30, scale: 100 },
    lines: [], cutPolygons: [], projectionPolygons: [],
    bounds: { min: { x: 0, y: 0 }, max: { x: widthM, y: 4 } },
    stats: { cutLineCount: 0, projectionLineCount: 0, hiddenLineCount: 0, silhouetteLineCount: 0, polygonCount: 0, totalTriangles: 0, processingTimeMs: 0 },
  };
}

/** A sheet at `factor` whose title block keeps the default field text, '1:100'. */
function sheetAt(factor: number): DrawingSheet {
  const paper = PAPER_SIZE_REGISTRY.A3_LANDSCAPE;
  const frame = { style: 'professional' as const, ...FRAME_PRESETS.professional };
  const titleBlock = { ...TITLE_BLOCK_PRESETS.standard, fields: DEFAULT_TITLE_BLOCK_FIELDS.map((f) => ({ ...f })), logo: null };
  return {
    id: `sheet-${factor}`, name: 'sheet', paper, frame, titleBlock,
    scaleBar: { ...DEFAULT_SCALE_BAR }, scale: { name: `1:${factor}`, factor, useCase: '' },
    northArrow: { ...DEFAULT_NORTH_ARROW }, viewportBounds: calculateViewportBounds(paper, frame, titleBlock), revisions: [],
  };
}

/** Zoomed in (4 px per mm) so the title block's small text is drawn, not skipped as unreadable. */
function previewTexts(sheet: DrawingSheet, drawing: Drawing2D): string[] {
  const stub = installCanvasStub();
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root: Root | null = null;
  const cachedSheetTransformRef: React.MutableRefObject<CachedSheetTransform | null> = { current: null };
  try {
    act(() => {
      root = createRoot(container);
      root.render(
        <Drawing2DCanvas drawing={drawing} transform={{ x: 0, y: 0, scale: 4 }} showHiddenLines={false}
          overrideEngine={new GraphicOverrideEngine()} overridesEnabled={false} entityColorMap={new Map()}
          useIfcMaterials={false} sectionAxis="down" sheetEnabled activeSheet={sheet} cachedSheetTransformRef={cachedSheetTransformRef} />,
      );
    });
    return stub.texts;
  } finally {
    act(() => { root?.unmount(); });
    container.remove();
    stub.restore();
  }
}

describe('Drawing2DCanvas title block Scale (#11581)', () => {
  it('previews the placed scale, not a stale stored field, when nothing was clamped', () => {
    const sheet = sheetAt(50);
    assert.equal(sheet.titleBlock.fields.find((f) => f.id === 'scale')?.value, '1:100', 'fixture carries the stale copy');
    const texts = previewTexts(sheet, drawingSpanning(4));
    assert.ok(texts.includes('1:50'), `the title block previews 1:50; drew ${JSON.stringify(texts)}`);
    assert.ok(!texts.includes('1:100'), 'the stale 1:100 copy is not drawn');
  });

  it('previews the clamped ratio when the viewport fit shrinks the drawing', () => {
    // A 1000 m drawing cannot fit A3 at 1:100, so the fit clamps it far below that.
    const texts = previewTexts(sheetAt(100), drawingSpanning(1000));
    assert.ok(!texts.includes('1:100'), `the requested 1:100 is not drawn for a clamped sheet; drew ${JSON.stringify(texts)}`);
    assert.ok(texts.some((t) => /^1:\d/.test(t)), 'a scale ratio is still drawn');
  });
});
