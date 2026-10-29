/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The retained kernel as the viewer sees it (#7955 M2). Only a
 * `VITE_RETAINED_GEOMETRY=on` build resolves `@ifc-lite/viewer-retained` here;
 * the default build gets `off.ts` (`null`). Importing this module does no work
 * and fetches nothing: the host Worker and engine load on the first retained
 * load.
 */

import { useViewerStore } from '@/store';
import { requestedGeometryKernel } from '@/store/geometryKernel';
import { hasRetainedShapeOnlyModel } from '@/store/retainedGeometry';
import { RetainedGeometryChip } from '@/components/viewer/RetainedGeometryChip';
import { GeometryKernelSetting } from '@/components/viewer/settings/GeometryKernelSetting';
import { RetainedClient } from './retained-client';
import { beginRetainedLoad } from './retainedLoad';
import type { RetainedKernel } from './kernel';

const client = new RetainedClient();

// Closing the retained model releases the host Worker (and its SMLib heap).
// A load that replaces it keeps the warm Worker: `loading` is set in the same
// synchronous step that clears the models, so it is checked a tick later.
let retainedOpen = false;
useViewerStore.subscribe((state) => {
  const open = hasRetainedShapeOnlyModel(state.models);
  if (retainedOpen && !open) {
    setTimeout(() => {
      const now = useViewerStore.getState();
      if (!now.loading && !hasRetainedShapeOnlyModel(now.models)) client.unload();
    }, 0);
  }
  retainedOpen = open;
});

// Typed `| null` like `off.ts`, so call sites read the same under either mapping.
export const retainedKernel: RetainedKernel | null = {
  requested: requestedGeometryKernel,
  begin: (file, target, retry) => beginRetainedLoad(client, file, target, retry),
  Chip: RetainedGeometryChip,
  KernelSetting: GeometryKernelSetting,
};
