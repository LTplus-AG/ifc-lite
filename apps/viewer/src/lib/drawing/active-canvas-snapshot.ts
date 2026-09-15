/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The mounted 2D drawing canvas is owned by `Drawing2DCanvas`, while BCF topic
 * controls live elsewhere in the viewer tree. This tiny registry exposes the
 * already-painted canvas without rebuilding the section in a second pipeline.
 */

import type { Drawing2D } from '@ifc-lite/drawing-2d';

let activeCanvas: HTMLCanvasElement | null = null;
let activeRegistration: symbol | null = null;
let renderedDrawing: WeakRef<Drawing2D> | null = null;
let capturableDrawing: WeakRef<Drawing2D> | null = null;
let renderedDrawingReady = false;
let generationPending = false;
const listeners = new Set<() => void>();

function notifyListeners(): void {
  for (const listener of listeners) listener();
}

/** Register the canvas that currently presents the 2D section. */
export function registerActiveDrawingCanvas(canvas: HTMLCanvasElement, drawing: Drawing2D): () => void {
  const registration = Symbol('drawing-canvas-registration');
  activeCanvas = canvas;
  activeRegistration = registration;
  renderedDrawing = null;
  renderedDrawingReady = false;
  if (!generationPending) capturableDrawing = new WeakRef(drawing);
  notifyListeners();
  return () => {
    // A stale cleanup must not unregister a newer mounted canvas.
    if (activeRegistration === registration) {
      activeCanvas = null;
      activeRegistration = null;
      renderedDrawing = null;
      capturableDrawing = null;
      renderedDrawingReady = false;
      notifyListeners();
    }
  };
}

/** Prevent an old bitmap from being paired with section state still updating. */
export function markActiveDrawingGenerationStarted(): void {
  generationPending = true;
  capturableDrawing = null;
  notifyListeners();
}

/** Identify the replacement drawing that a completed generation produced. */
export function markActiveDrawingGenerationCompleted(drawing: Drawing2D): void {
  generationPending = false;
  capturableDrawing = new WeakRef(drawing);
  notifyListeners();
}

/** Publish the exact drawing identity only after its canvas paint has completed. */
export function markActiveDrawingCanvasRendered(
  canvas: HTMLCanvasElement,
  drawing: Drawing2D,
  ready: boolean,
): void {
  if (activeCanvas !== canvas) return;
  renderedDrawing = new WeakRef(drawing);
  renderedDrawingReady = ready;
  notifyListeners();
}

/** Observe whether the section canvas is actually mounted and capturable. */
export function subscribeActiveDrawingCanvas(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** React-compatible snapshot of the mounted canvas state. */
export function hasActiveDrawingCanvas(): boolean {
  const rendered = renderedDrawing?.deref();
  return !generationPending
    && renderedDrawingReady
    && rendered !== undefined
    && rendered === capturableDrawing?.deref()
    && activeCanvas !== null
    && activeCanvas.width > 0
    && activeCanvas.height > 0;
}

/** Capture the exact painted 2D section, including its visible annotations. */
export function captureActiveDrawingSnapshot(): string | null {
  if (!activeCanvas || !hasActiveDrawingCanvas()) return null;
  const snapshot = activeCanvas.toDataURL('image/png');
  return snapshot.startsWith('data:image/png') ? snapshot : null;
}
