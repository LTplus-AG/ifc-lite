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
 * Throws when the drawing cannot see every instanced occurrence: no renderer
 * yet, shards still queued, or (with `modelOf`) a visible model that streamed
 * shards but has no occurrence in the scene, e.g. a replaced, empty scene or
 * shards dropped on upload. Its flat meshes alone are not its drawing.
 */
export function assertInstancedReady(state: PresenceState, renderer: Pick<Renderer, 'getScene'> | null,
  modelOf?: (globalId: number) => string | undefined): void {
  const { queued, present } = presence(state, renderer);
  if (!renderer && present) throw new GeometryUnavailableError('Instanced geometry cannot be drawn before the viewport renderer exists');
  if (queued) throw new DrawingGeometryPendingError();
  if (!renderer || !modelOf) return;
  const recorded = [...state.models].filter(([id, model]) => model.visible && hasInstancedShards(id)).map(([id]) => id);
  if (recorded.length === 0) return;
  const inScene = new Set<string>();
  for (const id of renderer.getScene().getInstancedEntityIds()) {
    const owner = modelOf(id);
    if (owner !== undefined) inScene.add(owner);
    if (inScene.size === recorded.length) break;
  }
  const missing = recorded.filter((id) => !inScene.has(id));
  if (missing.length > 0) throw new GeometryUnavailableError(`Instanced geometry of ${missing.join(', ')} is not in the scene; it cannot be drawn`);
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
