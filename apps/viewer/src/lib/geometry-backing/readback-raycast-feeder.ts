/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Measurement and snapping over released geometry (#10264). The renderer's
 * raycast and magnetic snap are synchronous over CPU pieces; once a scene's
 * pieces are released they have nothing to test. Before a tool raycasts, the
 * feeder asks the GPU which entity is under the pointer (S1 batch pick, which
 * keeps working on released scenes), leases that entity plus the backed
 * chunks around the hit, places them in the current model frame and hands
 * them to the renderer's raycast as readback pieces. The next synchronous
 * raycast and snap then answer exactly as over resident pieces.
 *
 * Bounded: one lease set at a time, capped by bytes; a newer pointer position
 * cancels an older prefetch. A model without a complete current backing gets
 * no readback pieces; the tool then finds no hit instead of a wrong one, and
 * `lastOutcome` says why.
 */

import type { MeshData } from '@ifc-lite/geometry';
import type { SceneContents } from '@ifc-lite/renderer';
import type { MeshLease } from './backing-reader';
import { type BackingSource, GeometryUnavailableError } from './geometry-readback';

export interface ReadbackRaycastHost {
  pick(x: number, y: number, options?: { hiddenIds?: ReadonlySet<number>; isolatedIds?: ReadonlySet<number> | null }):
    Promise<{ expressId: number; modelIndex?: number; worldXYZ?: { x: number; y: number; z: number } } | null>;
  getScene(): Pick<SceneContents, 'placeAppearanceSource' | 'getEntityBoundingBox'>;
  setReadbackRaycastMeshes(meshes: readonly MeshData[] | null): void;
}

export type FeedOutcome = 'resident' | 'fed' | 'no-hit' | 'unavailable' | 'cancelled';

/** World half-size of the neighbourhood leased around a hit (snap reaches edges nearby). */
const NEIGHBOURHOOD_METRES = 1;
export const DEFAULT_FEED_BYTES = 64 * 1024 * 1024;

function released(scene: object): boolean {
  return 'isGeometryDataReleased' in scene && typeof scene.isGeometryDataReleased === 'function'
    && scene.isGeometryDataReleased() === true;
}

function place(scene: Pick<SceneContents, 'placeAppearanceSource'>, mesh: MeshData): MeshData {
  // Backed meshes are model-local store sources; scene pieces carry the model translation.
  if (!scene.placeAppearanceSource) throw new GeometryUnavailableError('This renderer cannot place readback geometry in its model frame');
  return scene.placeAppearanceSource(mesh);
}

/**
 * Only a model's translation is inverted below (scene hit to model-local source). A rotated model, or a scene
 * that cannot say, fails closed: subtracting the offset alone would search the wrong neighbourhood (#10880).
 */
function placementRotated(scene: object, modelIndex: number | undefined): boolean {
  if (!('getModelRotation' in scene) || typeof scene.getModelRotation !== 'function') return true;
  return scene.getModelRotation(modelIndex ?? 0) !== null;
}

/** The model's current placement offset, measured through the scene's own placement. */
function modelOffset(scene: Pick<SceneContents, 'placeAppearanceSource'>, modelIndex: number | undefined): [number, number, number] {
  const probe: MeshData = { expressId: 0, positions: new Float32Array(0), normals: new Float32Array(0),
    indices: new Uint32Array(0), color: [0, 0, 0, 0], origin: [0, 0, 0], ...(modelIndex !== undefined ? { modelIndex } : {}) };
  return place(scene, probe).origin ?? [0, 0, 0];
}

export class ReadbackRaycastFeeder {
  private leases: MeshLease[] = [];
  private controller: AbortController | undefined;
  lastOutcome: FeedOutcome = 'resident';
  lastError: Error | undefined;

  constructor(
    private readonly host: ReadbackRaycastHost,
    private readonly source: () => BackingSource | undefined,
    /** Federated owner of a renderer/global id. */
    private readonly owner: (globalId: number) => string | undefined,
    private readonly budgetBytes = DEFAULT_FEED_BYTES,
  ) {}

  /** Prepare readback pieces for a raycast at canvas CSS (x, y). */
  async prepare(x: number, y: number, visibility: { hiddenIds?: ReadonlySet<number>; isolatedIds?: ReadonlySet<number> | null } = {}):
    Promise<FeedOutcome> {
    const scene = this.host.getScene();
    if (!released(scene)) { this.clear(); return this.finish('resident'); }
    this.controller?.abort(new DOMException('Superseded by a newer pointer position', 'AbortError'));
    const controller = new AbortController();
    this.controller = controller;
    const { signal } = controller;
    try {
      const hit = await this.host.pick(x, y, visibility);
      signal.throwIfAborted();
      if (!hit) { this.swap([], []); return this.finish('no-hit'); }
      const modelId = this.owner(hit.expressId);
      const backing = modelId ? this.source()?.backing(modelId) : undefined;
      if (!modelId || !backing?.isCurrent || !backing.isComplete) {
        throw new GeometryUnavailableError(`No complete geometry backing for entity ${hit.expressId}`);
      }
      if (placementRotated(scene, hit.modelIndex)) {
        throw new GeometryUnavailableError(`Model ${modelId} is rotated; readback of rotated placements is not available yet`);
      }
      const leases: MeshLease[] = [];
      try {
        const own = await backing.reader.leaseEntity(hit.expressId, { signal });
        leases.push(own);
        // An instanced (or otherwise unbacked) front surface: feeding the flat
        // neighbourhood alone would let the ray pass through it and measure
        // whatever lies behind. Refuse instead of answering wrongly. An entity
        // with BOTH flat pieces and instanced occurrences counts too: the GPU hit
        // may be the occurrence in front of its own flat piece, and this layer
        // cannot read occurrences back.
        if (backing.directory.shardsOf(hit.expressId).length > 0) {
          throw new GeometryUnavailableError(`Entity ${hit.expressId} has instanced occurrences; instanced readback for tools is not available yet`);
        }
        if (own.meshes.length === 0) throw new GeometryUnavailableError(`Entity ${hit.expressId} has no backed flat geometry`);
        const p = hit.worldXYZ;
        if (p) {
          // The hit is in the placed scene frame; directory bounds are model-local sources.
          const [dx, dy, dz] = modelOffset(scene, hit.modelIndex);
          const x = p.x - dx, y = p.y - dy, z = p.z - dz, r = NEIGHBOURHOOD_METRES;
          const chunks = backing.directory.chunksIntersecting([x - r, y - r, z - r], [x + r, y + r, z + r]);
          // Greedy within the budget: a chunk that does not fit is skipped, never charged.
          let bytes = 0;
          const within = chunks.filter((index) => {
            const size = backing.directory.chunks[index].bytes;
            if (bytes + size > this.budgetBytes) return false;
            bytes += size;
            return true;
          });
          leases.push(await backing.reader.leaseChunks(within, { signal }));
        }
        signal.throwIfAborted();
      } catch (error) {
        for (const lease of leases) lease.release();
        throw error;
      }
      const seen = new Set<MeshData>();
      const meshes: MeshData[] = [];
      try {
        for (const lease of leases) for (const mesh of lease.meshes) {
          if (seen.has(mesh)) continue;
          seen.add(mesh);
          // Only what the scene draws: the store also holds type-filtered meshes
          // (spaces, openings) and class-2 type templates the scene never had.
          if ((mesh.geometryClass ?? 0) === 2 || scene.getEntityBoundingBox(mesh.expressId) === null) continue;
          meshes.push(place(scene, mesh));
        }
      } catch (error) {
        // These leases were never handed to `swap`: release them here, or a failed placement pins them.
        for (const lease of leases) lease.release();
        throw error;
      }
      this.swap(leases, meshes);
      return this.finish('fed');
    } catch (error) {
      if (signal.aborted) return this.finish('cancelled');
      this.swap([], []);
      this.lastError = error instanceof Error ? error : new Error(String(error));
      return this.finish('unavailable');
    } finally {
      if (this.controller === controller) this.controller = undefined;
    }
  }

  private finish(outcome: FeedOutcome): FeedOutcome {
    if (outcome !== 'unavailable') this.lastError = undefined;
    this.lastOutcome = outcome;
    return outcome;
  }

  private swap(leases: MeshLease[], meshes: MeshData[]): void {
    this.host.setReadbackRaycastMeshes(meshes.length > 0 ? meshes : null);
    for (const lease of this.leases) lease.release();
    this.leases = leases;
  }

  /** Drop readback pieces and leases (tool closed, model changed). */
  clear(): void {
    this.controller?.abort(new DOMException('Readback cleared', 'AbortError'));
    this.controller = undefined;
    this.swap([], []);
  }
}
