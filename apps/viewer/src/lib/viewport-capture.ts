/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Renderer, RenderOptions } from '@ifc-lite/renderer';

interface CaptureSession {
  options: () => RenderOptions;
  owned: boolean;
  tail: Promise<void>;
  controller: AbortController;
  canvas: HTMLCanvasElement;
}

const sessions = new WeakMap<Renderer, CaptureSession>();

/** The canonical animation loop supplies its normal render options once. */
export function registerViewportCapture(renderer: Renderer, canvas: HTMLCanvasElement, options: () => RenderOptions): () => void {
  sessions.get(renderer)?.controller.abort();
  const session: CaptureSession = { options, owned: false, tail: Promise.resolve(), controller: new AbortController(), canvas };
  sessions.set(renderer, session);
  return () => {
    if (sessions.get(renderer) === session) sessions.delete(renderer);
    session.controller.abort();
  };
}

export function viewportCaptureOwnsFrame(renderer: Renderer): boolean {
  return sessions.get(renderer)?.owned ?? false;
}

interface CaptureRequest<T> {
  canvas?: HTMLCanvasElement;
  options?: RenderOptions;
  /** Synchronous camera preparation; the returned restoration runs inside the same lease. */
  prepare?: () => void | (() => void);
  /** Camera metadata belongs to the rendered frame, before asynchronous input can change it. */
  afterRender?: () => void;
  read: (canvas: HTMLCanvasElement) => T | Promise<T>;
}

function presentation(signal: AbortSignal): Promise<boolean> {
  // FRAME-WAIT-ALLOW(#2385): presentation, never a timeout, precedes canvas readback.
  return new Promise(resolve => {
    const abort = () => { cancelAnimationFrame(frame); resolve(false); };
    const frame = requestAnimationFrame(() => {
      signal.removeEventListener('abort', abort);
      resolve(!signal.aborted);
    });
    signal.addEventListener('abort', abort, { once: true });
  });
}

async function completion(work: Promise<void>, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return false;
  let abort = () => {};
  const cancelled = new Promise<boolean>(resolve => {
    abort = () => resolve(false);
    signal.addEventListener('abort', abort, { once: true });
  });
  try { return await Promise.race([work.then(() => true), cancelled]); }
  finally { signal.removeEventListener('abort', abort); }
}

/**
 * Serialize prepare → canonical full render → GPU completion → presentation →
 * readback. The live loop parks before updating camera or uploading while this
 * interval owns its frame. No persistent preferences are changed (#6709).
 */
export function captureViewportFrame<T>(renderer: Renderer, request: CaptureRequest<T>): Promise<T | null> {
  const session = sessions.get(renderer);
  if (!session) {
    console.warn('[capture] No active canonical viewport');
    return Promise.resolve(null);
  }
  if (request.canvas && request.canvas !== session.canvas) {
    console.warn('[capture] Canvas does not belong to the canonical viewport');
    return Promise.resolve(null);
  }
  // Snapshot visibility when requested, including mutable Set consumers.
  let source: RenderOptions;
  try { source = { ...session.options(), ...request.options }; }
  catch (error) {
    console.error('[capture] Viewport options unavailable:', error);
    return Promise.resolve(null);
  }
  const options: RenderOptions = {
    ...source,
    hiddenIds: source.hiddenIds ? new Set(source.hiddenIds) : undefined,
    isolatedIds: source.isolatedIds ? new Set(source.isolatedIds) : source.isolatedIds,
    ghostExceptIds: source.ghostExceptIds ? new Set(source.ghostExceptIds) : source.ghostExceptIds,
    selectedIds: source.selectedIds ? new Set(source.selectedIds) : undefined,
    isInteracting: false, maxPixelRatio: undefined, interactionFrameIntervalMs: undefined,
    contributionCull: undefined, lod: undefined, restoreEvictedForCapture: true,
  };
  const execute = async (): Promise<T | null> => {
    const signal = session.controller.signal;
    if (signal.aborted || sessions.get(renderer) !== session) return null;
    session.owned = true;
    let restore: void | (() => void) = undefined;
    try {
      restore = request.prepare?.();
      if (!renderer.renderWithResult(options)) {
        console.warn('[capture] Viewport render did not submit an owned frame');
        return null;
      }
      request.afterRender?.();
      const device = renderer.getGPUDevice();
      if (device && !await completion(device.queue.onSubmittedWorkDone(), signal)) return null;
      if (signal.aborted || !await presentation(signal)) return null;
      const value = await request.read(session.canvas);
      return signal.aborted ? null : value;
    } catch (error) {
      console.error('[capture] Viewport capture failed:', error);
      return null;
    } finally {
      try { if (!signal.aborted) restore?.(); }
      finally {
        session.owned = false;
        if (sessions.get(renderer) === session) renderer.requestRender();
      }
    }
  };
  const result = session.tail.then(execute);
  // A restoration failure is reported too, without poisoning the next capture.
  const reported = result.catch(error => { console.error('[capture] Viewport restoration failed:', error); return null; });
  session.tail = reported.then(() => {});
  return reported;
}
