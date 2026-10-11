/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { PickOptions, PickResult, Renderer } from '@ifc-lite/renderer';
import { useViewerStore } from '@/store';
import { referenceFrameStatus } from '@/lib/appearance/reference-runtime/frame.js';
import { pickLandXmlOverlayLine } from './landXmlOverlayPick.js';
import { captureViewportPick, invalidateViewportPick } from './viewportPickOwnership.js';

const touchClicks = new WeakMap<HTMLCanvasElement, { time: number; x: number; y: number }>();
export function invalidateSelectionPick(canvas: HTMLCanvasElement): void {
  invalidateViewportPick(canvas, 'selection');
}
export function markTouchSelection(canvas: HTMLCanvasElement, x: number, y: number): void {
  touchClicks.set(canvas, { time: Date.now(), x, y });
}
/** Touchend owns a tap. Ignore its compatibility click rather than selecting twice. */
export function isTouchSelectionClick(canvas: HTMLCanvasElement, event: MouseEvent, x: number, y: number): boolean {
  const pointer = event as MouseEvent & { pointerType?: string; sourceCapabilities?: { firesTouchEvents?: boolean } };
  if (pointer.pointerType === 'touch' || pointer.sourceCapabilities?.firesTouchEvents) return true;
  if (pointer.pointerType === 'mouse' || pointer.pointerType === 'pen') return false;
  const touch = touchClicks.get(canvas);
  if (!touch || Date.now() - touch.time > 700 || Math.abs(touch.x - x) > 5 || Math.abs(touch.y - y) > 5) return false;
  touchClicks.delete(canvas);
  return pointer.sourceCapabilities?.firesTouchEvents !== false;
}

/** Normal Select only. Keep reference strings outside the IFC pick/ID pipeline. */
export async function selectViewportTarget(options: {
  canvas: HTMLCanvasElement;
  renderer: Renderer;
  x: number; y: number;
  getTool: () => string;
  getPickOptions: () => PickOptions;
  onIfc: (pick: PickResult | null) => void;
  onReference?: () => void;
}): Promise<void> {
  const { renderer, x, y } = options;
  const { before, pickOptions, rect, camera, current } = captureViewportPick({
    ...options, channel: 'selection', isOwnerCurrent: () => options.getTool() === 'select',
  });
  if ([...before.appearanceReferences.values()].some(reference => reference.visible && !reference.locked && reference.opacity > 0 && referenceFrameStatus(reference, before) === 'ready')) {
    const hit = await renderer.getReferenceImages().pick(x, y, pickOptions);
    if (!current()) return;
    if (hit) {
      const reference = useViewerStore.getState().appearanceReferences.get(hit.referenceId);
      // A draft quad or stale renderer resource never becomes a registered selection.
      if (reference?.visible && !reference.locked && reference.opacity > 0 && referenceFrameStatus(reference, before) === 'ready') {
        useViewerStore.getState().selectAppearanceReference(hit.referenceId);
        options.onReference?.();
        return;
      }
    }
  }
  const pick = await renderer.pick(x, y, pickOptions);
  if (!current()) return;
  useViewerStore.getState().selectAppearanceReference(null);
  if (!pick) {
    const sourceRef = pickLandXmlOverlayLine(useViewerStore.getState(), camera, x, y, rect.width, rect.height);
    if (sourceRef) {
      useViewerStore.getState().setSelectedLandXmlSource(sourceRef);
      return;
    }
  }
  options.onIfc(pick);
}
