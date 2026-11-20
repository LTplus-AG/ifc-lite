/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Whether the drawn models have GPU-instanced geometry, independent of their
 * flat mesh list (#10264): a model can be instanced only, so an empty flat
 * list is not "no geometry". Instanced shards are queued by the loader and
 * drained into the scene once a renderer with a device exists; while any are
 * still queued the drawing would miss them, so it waits (renderer present)
 * or refuses (no renderer) instead of publishing a partial drawing.
 */

import { useEffect, useState } from 'react';
import type { Renderer } from '@ifc-lite/renderer';
import type { ViewerState } from '@/store';
import { hasInstancedShards } from '@/store/instancedShardModels';
import { hasPendingInstancedShards, subscribeInstancedShards } from '@/store/instancedShardQueue';
import { subscribeGlobalRenderer } from '@/hooks/useBCF';
import { GeometryUnavailableError } from '@/lib/geometry-backing/geometry-readback';

/** Instanced shards of the drawn models are queued but not yet in the scene; a drain retriggers the drawing. */
export class DrawingGeometryPendingError extends Error {
  constructor(message = 'Instanced geometry is still being uploaded') {
    super(message);
    this.name = 'DrawingGeometryPendingError';
  }
}

type PresenceState = Pick<ViewerState, 'models'>;

interface InstancedPresence { queued: boolean; present: boolean }

function presence(state: PresenceState, renderer: Pick<Renderer, 'getScene'> | null): InstancedPresence {
  const scene = renderer ? renderer.getScene().getInstancedEntityCount() > 0 : false;
  // Legacy single-model mode registers no model: any queued or uploaded shard is its own.
  if (state.models.size === 0) {
    const queued = hasPendingInstancedShards();
    return { queued, present: queued || scene };
  }
  const visible = [...state.models].filter(([, model]) => model.visible).map(([id]) => id);
  const queued = visible.some((id) => hasPendingInstancedShards(id));
  return { queued, present: queued || scene || visible.some((id) => hasInstancedShards(id)) };
}

/** Flat meshes or instanced geometry: anything a drawing of these models could cut. */
export function drawingHasGeometry(flatCount: number, state: PresenceState, renderer: Pick<Renderer, 'getScene'> | null): boolean {
  return flatCount > 0 || presence(state, renderer).present;
}

/**
 * Throws when the drawing cannot yet see every instanced occurrence: no
 * renderer, or shards still queued. A model that recorded shards is NOT
 * required to own a scene occurrence: only opaque occurrences are uploaded,
 * and real models (AC20-FZK-Haus, duplex) record shards with none, so that
 * test refused their drawings on a real GPU. The drawing mirrors the scene.
 */
export function assertInstancedReady(state: PresenceState, renderer: Pick<Renderer, 'getScene'> | null, sinceEpoch?: number): void {
  const { queued, present } = presence(state, renderer);
  if (!renderer && present) throw new GeometryUnavailableError('Instanced geometry cannot be drawn before the viewport renderer exists');
  // Queued, or enqueued AND drained since the cut began (`sinceEpoch`): the cut may have missed it.
  if (queued || (sinceEpoch !== undefined && instancedEpoch() !== sinceEpoch)) throw new DrawingGeometryPendingError();
}

let epoch = 0;
let watching = false;
/** Counts every shard enqueue, drain or discard and renderer change, for the page's lifetime. */
export function instancedEpoch(): number {
  if (!watching) {
    watching = true;
    subscribeInstancedShards(() => { epoch++; });
    subscribeGlobalRenderer(() => { epoch++; });
  }
  return epoch;
}

/** Bumps whenever instanced shards reach (or leave) the scene, or the renderer changes: a drawing input. */
export function useInstancedDrawingRevision(): number {
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const bump = () => setRevision((value) => value + 1);
    const stopShards = subscribeInstancedShards((event) => { if (event.kind !== 'enqueued') bump(); });
    const stopRenderer = subscribeGlobalRenderer(bump);
    return () => { stopShards(); stopRenderer(); };
  }, []);
  return revision;
}
