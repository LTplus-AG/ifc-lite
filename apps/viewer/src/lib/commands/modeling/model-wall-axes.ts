/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useViewerStore } from '@/store';
import { storeyWallAxes } from '@/lib/snap/sources/semantic-walls';
import type { WallAxis } from '@/lib/snap/sources/semantic';

const EMPTY: ReadonlyMap<number, WallAxis> = new Map();
let cache: {
  modelId: string; storeyId: number; version: number;
  store: WeakRef<object>; view: WeakRef<object>;
  axes: ReadonlyMap<number, WallAxis>;
} | null = null;

/** Share one canonical read between semantic targets and body-target resolution.
 * Weak identities avoid keeping a closed model's source buffer alive. */
export function modelWallAxes(modelId: string, storeyId: number): ReadonlyMap<number, WallAxis> {
  const s = useViewerStore.getState();
  const store = s.models.get(modelId)?.ifcDataStore;
  const view = s.mutationViews.get(modelId);
  if (!store || !view) return EMPTY;
  if (!cache || cache.modelId !== modelId || cache.storeyId !== storeyId
    || cache.version !== s.mutationVersion || cache.store.deref() !== store || cache.view.deref() !== view) {
    cache = {
      modelId, storeyId, version: s.mutationVersion,
      store: new WeakRef(store), view: new WeakRef(view),
      axes: new Map(storeyWallAxes(store, view, storeyId).map((axis) => [axis.expressId, axis])),
    };
  }
  return cache.axes;
}
