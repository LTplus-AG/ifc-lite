/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useViewerStore } from '@/store';
import { isGeometryHeld } from '@/lib/pick-gating';

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

type HoldState = Parameters<typeof isGeometryHeld>[0] & {
  models: ReadonlyMap<string, { geometryRestorePending?: boolean; loadState?: string }>;
};

export class LatestHeldPointerQueue {
  private queued: (HeldPointerClick & { models: string[] }) | null = null;
  private invalidated = false;

  queue(click: HeldPointerClick, state: HoldState): boolean {
    if (!isGeometryHeld(state)) return false;
    const pending = [...state.models].filter(([, model]) => model.geometryRestorePending || model.loadState === 'loading').map(([id]) => id);
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

/** Pointer movement/presses, wheel and keys after the queued click make replay stale. */
export function observeHeldPointerInput(_canvas: HTMLCanvasElement): () => void {
  const invalidate = (event: Event) => {
    if (event.type !== 'pointermove' || (event as PointerEvent).buttons !== 0) heldPointerQueue.invalidate();
  };
  const key = () => heldPointerQueue.invalidate();
  document.addEventListener('pointerdown', invalidate, true);
  document.addEventListener('pointerup', invalidate, true);
  document.addEventListener('pointermove', invalidate, true);
  document.addEventListener('touchstart', invalidate, true);
  document.addEventListener('touchmove', invalidate, true);
  document.addEventListener('touchend', invalidate, true);
  document.addEventListener('wheel', invalidate, true);
  window.addEventListener('keydown', key, true);
  window.addEventListener('keyup', key, true);
  return () => {
    document.removeEventListener('pointerdown', invalidate, true);
    document.removeEventListener('pointerup', invalidate, true);
    document.removeEventListener('pointermove', invalidate, true);
    document.removeEventListener('touchstart', invalidate, true);
    document.removeEventListener('touchmove', invalidate, true);
    document.removeEventListener('touchend', invalidate, true);
    document.removeEventListener('wheel', invalidate, true);
    window.removeEventListener('keydown', key, true);
    window.removeEventListener('keyup', key, true);
  };
}
