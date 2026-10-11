/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { PickOptions, Renderer } from '@ifc-lite/renderer';
import { useViewerStore, type ViewerState } from '@/store';

type PickChannel = 'selection' | 'hover';
const requests = new WeakMap<HTMLCanvasElement, Partial<Record<PickChannel, number>>>();

/** Independent callers share validity rules without superseding each other. */
export function invalidateViewportPick(canvas: HTMLCanvasElement, channel: PickChannel): number {
  const channels = requests.get(canvas) ?? {};
  const request = (channels[channel] ?? 0) + 1;
  channels[channel] = request;
  requests.set(canvas, channels);
  return request;
}

function sceneStamp(state: ViewerState): readonly unknown[] {
  return [state.models, state.geometryResult, state.geometryUpdateTick, state.mutationVersion,
    state.referenceRevision, state.modelPlacement, state.sectionPlane, state.hiddenEntities,
    state.isolatedEntities, state.ghostExceptEntities, state.activeTool];
}

/** Capture the selection contract once for asynchronous viewport consumers (#6881). */
export function captureViewportPick(options: {
  canvas: HTMLCanvasElement; renderer: Renderer; channel: PickChannel;
  getTool: () => string; getPickOptions: () => PickOptions;
  isOwnerCurrent?: () => boolean;
}) {
  const { canvas, renderer, channel } = options;
  const request = invalidateViewportPick(canvas, channel);
  const camera = renderer.getCamera(), tool = options.getTool();
  const matrix = Array.from(camera.getViewProjMatrix().m);
  const before = useViewerStore.getState(), stamp = sceneStamp(before);
  const pickOptions = options.getPickOptions(), rect = canvas.getBoundingClientRect();
  const current = () => {
    const next = options.getPickOptions(), bounds = canvas.getBoundingClientRect();
    return requests.get(canvas)?.[channel] === request && options.getTool() === tool
      && (options.isOwnerCurrent?.() ?? true)
      && matrix.every((value, index) => value === camera.getViewProjMatrix().m[index])
      && sceneStamp(useViewerStore.getState()).every((value, index) => Object.is(value, stamp[index]))
      && next.isStreaming === pickOptions.isStreaming && next.hiddenIds === pickOptions.hiddenIds && next.isolatedIds === pickOptions.isolatedIds
      && bounds.left === rect.left && bounds.top === rect.top && bounds.width === rect.width && bounds.height === rect.height;
  };
  return { before, pickOptions, rect, camera, current };
}
