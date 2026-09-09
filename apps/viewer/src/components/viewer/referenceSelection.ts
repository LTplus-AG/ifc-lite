/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { PickOptions, PickResult, Renderer } from '@ifc-lite/renderer';
import { useViewerStore, type ViewerState } from '@/store';
import { referenceFrameStatus } from '@/lib/appearance/reference-runtime/frame.js';

const requests = new WeakMap<HTMLCanvasElement, number>();
const touchClicks = new WeakMap<HTMLCanvasElement, { time: number; x: number; y: number }>();
export function invalidateSelectionPick(canvas: HTMLCanvasElement): void {
  requests.set(canvas, (requests.get(canvas) ?? 0) + 1);
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
function sceneStamp(state: ViewerState): readonly unknown[] {
  return [state.models, state.geometryResult, state.geometryUpdateTick, state.mutationVersion,
    state.referenceRevision, state.modelPlacement, state.sectionPlane, state.hiddenEntities,
    state.isolatedEntities, state.ghostExceptEntities, state.activeTool];
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
  const { canvas, renderer, x, y } = options;
  invalidateSelectionPick(canvas);
  const request = requests.get(canvas);
  const camera = renderer.getCamera();
  const matrix = Array.from(camera.getViewProjMatrix().m);
  const before = useViewerStore.getState(), stamp = sceneStamp(before);
  const pickOptions = options.getPickOptions();
  const rect = canvas.getBoundingClientRect();
  const current = () => {
    const next = options.getPickOptions(), bounds = canvas.getBoundingClientRect();
    return requests.get(canvas) === request && options.getTool() === 'select'
      && matrix.every((value, index) => value === camera.getViewProjMatrix().m[index])
      && sceneStamp(useViewerStore.getState()).every((value, index) => Object.is(value, stamp[index]))
      && next.isStreaming === pickOptions.isStreaming && next.hiddenIds === pickOptions.hiddenIds && next.isolatedIds === pickOptions.isolatedIds
      && bounds.left === rect.left && bounds.top === rect.top && bounds.width === rect.width && bounds.height === rect.height;
  };
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
  options.onIfc(pick);
}
