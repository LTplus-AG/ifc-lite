/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Drawing2D } from '@ifc-lite/drawing-2d';
import {
  hasActiveDrawingCanvas,
  markActiveDrawingCanvasRendered,
  markActiveDrawingGenerationSettled,
  markActiveDrawingGenerationStarted,
  registerActiveDrawingCanvas,
} from './active-canvas-snapshot.js';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

/** The registry keys on object identity only; no field of the drawing is read. */
function drawingIdentity(): Drawing2D {
  return { lines: [], cutPolygons: [] } as unknown as Drawing2D;
}

/** What `Drawing2DCanvas` does when it mounts and paints `drawing`. */
function mountCanvasFor(drawing: Drawing2D): void {
  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 480;
  cleanups.push(registerActiveDrawingCanvas(canvas, drawing));
  markActiveDrawingCanvasRendered(canvas, drawing, true);
}

it('a generation that ends without publishing keeps the on-screen bitmap uncapturable (#4802, #9488 probe P-B)', () => {
  markActiveDrawingGenerationSettled();
  const shown = drawingIdentity();
  mountCanvasFor(shown);
  assert.equal(hasActiveDrawingCanvas(), true, 'a painted canvas with no generation in flight is capturable');
  markActiveDrawingGenerationStarted();
  assert.equal(hasActiveDrawingCanvas(), false, 'blocked while a generation is pending');
  markActiveDrawingGenerationSettled();
  assert.equal(hasActiveDrawingCanvas(), false,
    'the old bitmap was never proven current, so ending the generation must not revalidate it');
});

it('a canvas mounted after the generation ended is capturable again (#9488)', () => {
  markActiveDrawingGenerationStarted();
  markActiveDrawingGenerationSettled();
  mountCanvasFor(drawingIdentity());
  assert.equal(hasActiveDrawingCanvas(), true);
});
