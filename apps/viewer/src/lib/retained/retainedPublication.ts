/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { calculateMeshBounds } from '@/utils/localParsingUtils';
import type { RetainedHostEvent } from './retained-protocol';
import type { RetainedFaceRow } from '@/store/retainedGeometry';
import { faceRows } from './retainedFaces';

interface PublicationState {
  received: Set<number>;
  summary: { published: number };
  obligations: Set<string>;
  meshes: number;
  faces: Map<number, RetainedFaceRow[]>;
  bounds: ReturnType<typeof calculateMeshBounds>['bounds'] | null;
}

/** Account for every product in a shard before yielding its geometry to the loader. */
export function recordRetainedPublication(acc: PublicationState,
  event: Extract<RetainedHostEvent, { kind: 'published' }>): void {
  for (const product of event.instanceProducts ?? [event]) {
    if (product.faceRows) acc.faces.set(product.expressId, product.faceRows);
    else if (product.faces) acc.faces.set(product.expressId, faceRows(product.faces, event.meshes));
    acc.received.add(product.expressId);
    acc.summary.published++;
    for (const obligation of product.obligationsUnmet) acc.obligations.add(obligation);
  }
  acc.meshes += event.meshCount ?? event.meshes.length;
  if (!event.meshes.length && !event.bounds) return;
  const bounds = event.bounds ?? calculateMeshBounds(event.meshes).bounds;
  if (!acc.bounds) { acc.bounds = bounds; return; }
  for (const axis of ['x', 'y', 'z'] as const) {
    acc.bounds.min[axis] = Math.min(acc.bounds.min[axis], bounds.min[axis]);
    acc.bounds.max[axis] = Math.max(acc.bounds.max[axis], bounds.max[axis]);
  }
}
