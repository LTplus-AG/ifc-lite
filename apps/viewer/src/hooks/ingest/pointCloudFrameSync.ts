// SPDX-License-Identifier: MPL-2.0
import { totalYupOffset } from '@/lib/geo/coordinate-frame';
import { sharedRenderFrame } from '@/lib/render-frame/sharedRenderFrame';
import { useViewerStore } from '@/store';
import { getGlobalRenderer } from '../useBCF.js';
import { reframeRegisteredPointClouds, type PointCloudTransformTarget } from './pointCloudAlignmentRegistry.js';

let subscribed = false;

/** Model publication, RTC convergence and removal all publish a models change. */
export function syncPointCloudRenderFrame(renderer: PointCloudTransformTarget | null | undefined): void {
  const state = useViewerStore.getState();
  reframeRegisteredPointClouds(renderer, totalYupOffset(sharedRenderFrame(state.models.values(), state.geometryResult)));
}

/** Install the frame-change seam when the first scan starts streaming. */
export function watchPointCloudRenderFrame(renderer: PointCloudTransformTarget): void {
  if (!subscribed) {
    subscribed = true;
    useViewerStore.subscribe((state, previous) => {
      if (state.models !== previous.models || state.geometryResult !== previous.geometryResult) {
        syncPointCloudRenderFrame(getGlobalRenderer());
      }
    });
  }
  syncPointCloudRenderFrame(renderer);
}
