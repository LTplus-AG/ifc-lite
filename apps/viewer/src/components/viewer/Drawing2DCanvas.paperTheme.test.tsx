/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Drawing canvas's paper/ink follow the app theme (#5496) instead of
 * always painting `#ffffff` (`#e5e5e5` in sheet mode). Every assertion here
 * is a colour actually handed to the 2D context, not a presence check —
 * `Drawing2DCanvas.propertyOverride.test.tsx` established the Proxy-stub
 * pattern this file reuses, because happy-dom implements `<canvas>` but not
 * a real 2D backend.
 *
 * Three behaviours, each with its own control so a guard that always forces
 * dark (or always forces white) cannot pass by accident:
 *  1. Direct-mode paper/ink read `OVERLAY_PALETTES` for the active theme.
 *  2. Print preview forces white paper/black ink regardless of theme.
 *  3. Sheet mode's own paper rectangle stays white in every theme — only the
 *     desk around it (the canvas clear) follows the theme.
 */

import '@/test/setup-dom.js';
import { installLayout } from '@/test/dom-layout.js';
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  GraphicOverrideEngine,
  PAPER_SIZE_REGISTRY,
  FRAME_PRESETS,
  TITLE_BLOCK_PRESETS,
  DEFAULT_TITLE_BLOCK_FIELDS,
  DEFAULT_SCALE_BAR,
  DEFAULT_NORTH_ARROW,
  calculateViewportBounds,
} from '@ifc-lite/drawing-2d';
import type { Drawing2D, DrawingSheet } from '@ifc-lite/drawing-2d';
import { Drawing2DCanvas } from './Drawing2DCanvas.js';
import { resolveDrawingPaperTheme, type DrawingPaperTheme } from './drawing/paper-theme.js';

installLayout();

const WALL_EXPRESS_ID = 72;

const DRAWING_WITH_WALL: Drawing2D = {
  config: { plane: { axis: 'y', position: 0, flipped: false }, projectionDepth: 10, includeHiddenLines: true, creaseAngle: 30, scale: 100 },
  lines: [],
  cutPolygons: [
    { polygon: { outer: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }], holes: [] }, entityId: WALL_EXPRESS_ID, ifcType: 'IfcWall', modelIndex: 0, isCut: true },
  ],
  projectionPolygons: [],
  bounds: { min: { x: 0, y: 0 }, max: { x: 10, y: 10 } },
  stats: { cutLineCount: 0, projectionLineCount: 0, hiddenLineCount: 0, silhouetteLineCount: 0, polygonCount: 1, totalTriangles: 0, processingTimeMs: 0 },
};

function sheetFixture(): DrawingSheet {
  const paper = PAPER_SIZE_REGISTRY.A3_LANDSCAPE;
  const frame = { style: 'professional' as const, ...FRAME_PRESETS.professional };
  const titleBlock = { ...TITLE_BLOCK_PRESETS.standard, fields: DEFAULT_TITLE_BLOCK_FIELDS.map((f) => ({ ...f })), logo: null };
  return {
    id: 'fixture', name: 'fixture', paper, frame, titleBlock,
    scaleBar: { ...DEFAULT_SCALE_BAR, visible: false },
    scale: { name: '1:100', factor: 100, useCase: '' },
    northArrow: { ...DEFAULT_NORTH_ARROW, style: 'none' },
    viewportBounds: calculateViewportBounds(paper, frame, titleBlock),
    revisions: [],
  };
}

/** Records every `fillStyle`/`strokeStyle` assignment, in order — the same
 *  Proxy stub `Drawing2DCanvas.propertyOverride.test.tsx` uses, extended to
 *  also capture stroke colour. */
function installCanvasStub(): { fillStyleCalls: string[]; strokeStyleCalls: string[]; restore: () => void } {
  const fillStyleCalls: string[] = [];
  const strokeStyleCalls: string[] = [];
  const store = new Map<string | symbol, unknown>();
  const ctx = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'canvas') return { width: 800, height: 600 };
        if (prop === 'measureText') return (text: string) => ({ width: String(text).length * 7 });
        if (store.has(prop)) return store.get(prop);
        return () => undefined;
      },
      set(_target, prop, value) {
        if (prop === 'fillStyle') fillStyleCalls.push(String(value));
        if (prop === 'strokeStyle') strokeStyleCalls.push(String(value));
        store.set(prop, value);
        return true;
      },
    },
  ) as unknown as CanvasRenderingContext2D;

  const original = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = ((kind: string) =>
    kind === '2d' ? ctx : null) as unknown as typeof HTMLCanvasElement.prototype.getContext;

  return { fillStyleCalls, strokeStyleCalls, restore: () => { HTMLCanvasElement.prototype.getContext = original; } };
}

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

interface RenderOptions {
  paperTheme: DrawingPaperTheme;
  sheetEnabled?: boolean;
  activeSheet?: DrawingSheet | null;
}

function renderCanvas({ paperTheme, sheetEnabled = false, activeSheet = null }: RenderOptions): void {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <Drawing2DCanvas
        drawing={DRAWING_WITH_WALL}
        transform={{ x: 0, y: 0, scale: 1 }}
        showHiddenLines={false}
        overrideEngine={new GraphicOverrideEngine()}
        overridesEnabled={false}
        entityColorMap={new Map()}
        useIfcMaterials={false}
        sectionAxis="down"
        sheetEnabled={sheetEnabled}
        activeSheet={activeSheet}
        paperTheme={paperTheme}
      />,
    );
  });
  mounted.push({ root, container });
}

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

describe('Drawing2DCanvas paper/ink follow the app theme (#5496)', () => {
  it('direct-mode paper is white in the light theme', () => {
    const stub = installCanvasStub();
    try {
      renderCanvas({ paperTheme: resolveDrawingPaperTheme('light', false) });
      assert.equal(stub.fillStyleCalls[0], '#ffffff', `expected the canvas clear to be white; got ${JSON.stringify(stub.fillStyleCalls)}`);
    } finally { stub.restore(); }
  });

  it('direct-mode paper is dark in the dark theme', () => {
    const stub = installCanvasStub();
    try {
      renderCanvas({ paperTheme: resolveDrawingPaperTheme('dark', false) });
      assert.equal(stub.fillStyleCalls[0], '#16161e', `expected the dark theme's paper token; got ${JSON.stringify(stub.fillStyleCalls)}`);
    } finally { stub.restore(); }
  });

  it('print preview forces white paper even in the dark theme', () => {
    const stub = installCanvasStub();
    try {
      renderCanvas({ paperTheme: resolveDrawingPaperTheme('dark', true) });
      assert.equal(stub.fillStyleCalls[0], '#ffffff', `print preview must force white regardless of theme; got ${JSON.stringify(stub.fillStyleCalls)}`);
    } finally { stub.restore(); }
  });

  it('the IFC type fill switches to its dark-paper analogue on dark paper', () => {
    const stub = installCanvasStub();
    try {
      renderCanvas({ paperTheme: resolveDrawingPaperTheme('dark', false) });
      assert.ok(stub.fillStyleCalls.includes('#4b4f63'), `expected the dark-paper IfcWall fill; got ${JSON.stringify(stub.fillStyleCalls)}`);
      assert.ok(!stub.fillStyleCalls.includes('#b0b0b0'), `the light IfcWall fill must not appear on dark paper; got ${JSON.stringify(stub.fillStyleCalls)}`);
    } finally { stub.restore(); }
  });

  it('the IFC type fill stays the light drafting colour on white paper (control)', () => {
    const stub = installCanvasStub();
    try {
      renderCanvas({ paperTheme: resolveDrawingPaperTheme('light', false) });
      assert.ok(stub.fillStyleCalls.includes('#b0b0b0'), `expected the light IfcWall fill; got ${JSON.stringify(stub.fillStyleCalls)}`);
      assert.ok(!stub.fillStyleCalls.includes('#4b4f63'), `the dark IfcWall fill must not appear on white paper; got ${JSON.stringify(stub.fillStyleCalls)}`);
    } finally { stub.restore(); }
  });

  it('the polygon outline ink follows the paper too', () => {
    const stub = installCanvasStub();
    try {
      renderCanvas({ paperTheme: resolveDrawingPaperTheme('dark', false) });
      assert.ok(stub.strokeStyleCalls.includes('#c0caf5'), `expected the dark theme's paper-ink stroke; got ${JSON.stringify(stub.strokeStyleCalls)}`);
    } finally { stub.restore(); }
  });

  it("sheet mode's own paper stays white in the dark theme; only the desk around it follows the theme", () => {
    const stub = installCanvasStub();
    try {
      renderCanvas({ sheetEnabled: true, activeSheet: sheetFixture(), paperTheme: resolveDrawingPaperTheme('dark', false) });
      assert.equal(stub.fillStyleCalls[0], '#2a2b3d', `expected the dark desk on the canvas clear; got ${JSON.stringify(stub.fillStyleCalls)}`);
      assert.equal(stub.fillStyleCalls[1], '#ffffff', `expected the sheet's own paper rectangle to stay white; got ${JSON.stringify(stub.fillStyleCalls)}`);
    } finally { stub.restore(); }
  });

  it('sheet mode keeps its original light desk in the light theme (control)', () => {
    const stub = installCanvasStub();
    try {
      renderCanvas({ sheetEnabled: true, activeSheet: sheetFixture(), paperTheme: resolveDrawingPaperTheme('light', false) });
      assert.equal(stub.fillStyleCalls[0], '#e5e5e5');
      assert.equal(stub.fillStyleCalls[1], '#ffffff');
    } finally { stub.restore(); }
  });
});
