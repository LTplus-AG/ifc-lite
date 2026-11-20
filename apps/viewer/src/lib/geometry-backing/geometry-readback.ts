/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Shared, bounded access to backed geometry for tools whose CPU arrays may be
 * released (#10264). Every consumer reads through here so the rules hold once:
 * - a mesh whose arrays are resident is answered from memory, unchanged;
 * - a released mesh is answered only from the model's CURRENT, COMPLETE
 *   backing generation; anything else is `GeometryUnavailableError`, never an
 *   empty or zero result;
 * - reads are leases (release them) and whole-model reads stream per chunk.
 */

import type { MeshData } from '@ifc-lite/geometry';
import { isReleasedMesh } from '@/lib/released-mesh-provenance';
import type { MeshLease, ReadOptions } from './backing-reader';
import type { ModelGeometryBacking } from './geometry-backing-registry';
import type { Vec3 } from './backing-directory';

export class GeometryUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GeometryUnavailableError';
  }
}

export interface BackingSource {
  backing(modelId: string): ModelGeometryBacking | undefined;
  /**
   * The current generation is not complete only because its instancing was lost, and every flat
   * record is whole and durable. Flat-only readers may use it where no instanced occurrence can be.
   */
  flatComplete?(modelId: string): boolean;
}

/** False exactly for a mesh whose arrays a CPU release replaced (release bookkeeping, not array shape). */
export function meshIsResident(mesh: MeshData): boolean {
  return !isReleasedMesh(mesh);
}

function completeBacking(source: BackingSource | undefined, modelId: string): ModelGeometryBacking {
  const backing = source?.backing(modelId);
  if (!backing || !backing.isCurrent) throw new GeometryUnavailableError(`Model ${modelId} has no current geometry backing`);
  if (!backing.isComplete) throw new GeometryUnavailableError(`Model ${modelId}'s geometry backing is incomplete`);
  return backing;
}

const NO_RELEASE = () => undefined;

/**
 * An entity's flat pieces: the resident ones from `resident` when every one is
 * resident, else all of them from the backing (never a mix of the two frames).
 */
export async function leaseEntityGeometry(
  source: BackingSource | undefined, modelId: string, expressId: number,
  resident: readonly MeshData[], options: ReadOptions = {},
): Promise<MeshLease> {
  if (resident.length > 0 && resident.every(meshIsResident)) return { meshes: resident, release: NO_RELEASE };
  return completeBacking(source, modelId).reader.leaseEntity(expressId, options);
}

/** Pieces of every chunk meeting a box, for neighbourhood tools (snap, caps). */
export async function leaseRegionGeometry(
  source: BackingSource | undefined, modelId: string, bounds: { min: Vec3; max: Vec3 }, options: ReadOptions = {},
): Promise<MeshLease> {
  const backing = completeBacking(source, modelId);
  return backing.reader.leaseChunks(backing.directory.chunksIntersecting(bounds.min, bounds.max), options);
}

/**
 * Stream a model's flat meshes: resident list as-is, or backed chunks one at a time. An empty list says
 * nothing about residency (`[].every` is vacuously true): a current, complete backing answers it, and with
 * none there is nothing to read (an empty model yields nothing, it does not fail).
 */
export async function* modelGeometry(
  source: BackingSource | undefined, modelId: string, resident: readonly MeshData[], options: ReadOptions = {},
): AsyncGenerator<readonly MeshData[]> {
  if (resident.length === 0) {
    const backing = source?.backing(modelId);
    if (backing?.isCurrent && backing.isComplete) yield* backing.reader.meshes(options);
    return;
  }
  if (resident.every(meshIsResident)) { yield resident; return; }
  yield* completeBacking(source, modelId).reader.meshes(options);
}
