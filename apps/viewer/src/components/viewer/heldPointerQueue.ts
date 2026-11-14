/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useViewerStore } from '@/store';
import { isGeometryHeld, type PickGatingState } from '@/lib/pick-gating';

export interface HeldPointerClick {
  x: number;
  y: number;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  button: number;
  handler: string;
  replay: (click: Omit<HeldPointerClick, 'replay'>) => void;
}

/** The store fields the queue reads: the gate's own, plus each model's load state (a failed load drops its queued click). */
type HoldState = Omit<PickGatingState, 'models'> & {
  models: ReadonlyMap<string, { geometryRestorePending?: boolean; loadState?: string }>;
};

export class LatestHeldPointerQueue {
  private queued: (HeldPointerClick & { models: string[] }) | null = null;
  private invalidated = false;

  queue(click: HeldPointerClick, state: HoldState): boolean {
    if (!isGeometryHeld(state)) return false;
    const pending = [...state.models].filter(([, model]) => model.geometryRestorePending).map(([id]) => id);
    const models = pending.length ? pending : [...state.models.keys()];
    if (!models.length) return false;
    this.queued = { ...click, models };
    this.invalidated = false;
    return true;
  }

  invalidate(): void {
    if (this.queued) this.invalidated = true;
  }

  release(state: HoldState): boolean {
    if (isGeometryHeld(state)) return false;
    const click = this.queued;
    this.queued = null;
    if (!click || this.invalidated) return false;
    if (click.models.some(id => {
      const model = state.models.get(id);
      return !model || model.loadState === 'error';
    })) return false;
    const { replay, models: _models, ...record } = click;
    replay(record);
    return true;
  }

  clear(): void { this.queued = null; this.invalidated = false; }
}

export const heldPointerQueue = new LatestHeldPointerQueue();

export function setViewportInteractionCursor(canvas: HTMLCanvasElement, cursor: string): void {
  if (!isGeometryHeld(useViewerStore.getState())) canvas.style.cursor = cursor;
}

let releaseSubscribed = false;
export function queueHeldPointerClick(click: HeldPointerClick): boolean {
  const state = useViewerStore.getState();
  if (!heldPointerQueue.queue(click, state as HoldState)) return false;
  if (!releaseSubscribed) {
    releaseSubscribed = true;
    useViewerStore.subscribe((next) => { heldPointerQueue.release(next as HoldState); });
  }
  return true;
}

/**
 * Newer user input after the queued click makes its replay stale. A newer gesture is detected at its START
 * (pointerdown/touchstart, a drag move, wheel, keydown); end events (pointerup/touchend/keyup) are not counted, because
 * they may belong to the queued click's own gesture (Chrome on Linux fires `contextmenu` on press, so the release
 * comes after the context-menu click was queued) and a newer gesture has already invalidated on its start.
 */
export function observeHeldPointerInput(_canvas: HTMLCanvasElement): () => void {
  const invalidate = (event: Event) => {
    if (event.type !== 'pointermove' || (event as PointerEvent).buttons !== 0) heldPointerQueue.invalidate();
  };
  const docEvents = ['pointerdown', 'pointermove', 'touchstart', 'touchmove', 'wheel'] as const;
  for (const type of docEvents) document.addEventListener(type, invalidate, true);
  window.addEventListener('keydown', invalidate, true);
  return () => {
    for (const type of docEvents) document.removeEventListener(type, invalidate, true);
    window.removeEventListener('keydown', invalidate, true);
  };
}
