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
 * Instanced occurrences come back from the backed shards (the flat backing
 * never held them): the picked entity's own, and instanced neighbours whose
 * retained scene bounds meet the same box, materialized as the renderer
 * uploads them and placed the same way as flat pieces.
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
import { readInstancedOccurrences } from './instanced-readback';

export interface ReadbackRaycastHost {
  pick(x: number, y: number, options?: { hiddenIds?: ReadonlySet<number>; isolatedIds?: ReadonlySet<number> | null }):
    Promise<{ expressId: number; modelIndex?: number; worldXYZ?: { x: number; y: number; z: number } } | null>;
  getScene(): Pick<SceneContents, 'placeAppearanceSource' | 'getEntityBoundingBox' | 'getInstancedEntityIds' | 'getInstancedEntityBounds'>;
  setReadbackRaycastMeshes(meshes: readonly MeshData[] | null, at?: { x: number; y: number }): void;
}

export type FeedOutcome = 'resident' | 'fed' | 'no-hit' | 'unavailable' | 'cancelled';

/** World half-size of the neighbourhood leased around a hit (snap reaches edges nearby). */
const NEIGHBOURHOOD_METRES = 1;
export const DEFAULT_FEED_BYTES = 64 * 1024 * 1024;
/** Overlay layers re-picked through before giving up. */
const MAX_SEE_THROUGH_LAYERS = 8;
/** Instanced neighbours materialized around one hit, at most. */
const MAX_INSTANCED_NEIGHBOURS = 256;

function released(scene: object): boolean {
  return 'isGeometryDataReleased' in scene && typeof scene.isGeometryDataReleased === 'function'
    && scene.isGeometryDataReleased() === true;
}

function place(scene: Pick<SceneContents, 'placeAppearanceSource'>, mesh: MeshData): MeshData {
  // Backed meshes are model-local store sources; scene pieces carry the model translation.
  if (!scene.placeAppearanceSource) throw new GeometryUnavailableError('This renderer cannot place readback geometry in its model frame');
  return scene.placeAppearanceSource(mesh);
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
    /** False for ids the resident raycast never tests (annotation and grid overlays). */
    private readonly raycastable: (globalId: number) => boolean = () => true,
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
      // The resident raycast passes through overlays the GPU pick sees (IfcAnnotation,
      // grids): re-pick with those hidden until the first raycastable surface.
      let hit = await this.host.pick(x, y, visibility);
      signal.throwIfAborted();
      const skipped = new Set(visibility.hiddenIds ?? []);
      for (let layer = 0; hit && !this.raycastable(hit.expressId); layer++) {
        if (layer >= MAX_SEE_THROUGH_LAYERS) throw new GeometryUnavailableError(`More than ${MAX_SEE_THROUGH_LAYERS} overlays under the pointer`);
        skipped.add(hit.expressId);
        hit = await this.host.pick(x, y, { ...visibility, hiddenIds: skipped });
        signal.throwIfAborted();
      }
      if (!hit) { this.swap([], [], { x, y }); return this.finish('no-hit'); }
      const modelId = this.owner(hit.expressId);
      const backing = modelId ? this.source()?.backing(modelId) : undefined;
      if (!modelId || !backing?.isCurrent || !backing.isComplete) {
        throw new GeometryUnavailableError(`No complete geometry backing for entity ${hit.expressId}`);
      }
      const leases: MeshLease[] = [];
      let instanced: MeshData[] = [];
      try {
        const own = await backing.reader.leaseEntity(hit.expressId, { signal });
        leases.push(own);
        const instancedIds = new Set<number>();
        if (backing.directory.shardsOf(hit.expressId).length > 0) instancedIds.add(hit.expressId);
        // An unbacked front surface: feeding the neighbourhood alone would let
        // the ray pass through it and measure whatever lies behind. Refuse.
        if (own.meshes.length === 0 && instancedIds.size === 0) {
          throw new GeometryUnavailableError(`Entity ${hit.expressId} has no backed geometry`);
        }
        const p = hit.worldXYZ;
        if (p) {
          const r = NEIGHBOURHOOD_METRES;
          // Instanced neighbours: the scene keeps occurrence bounds (placed frame) after release.
          for (const id of scene.getInstancedEntityIds()) {
            if (instancedIds.size >= MAX_INSTANCED_NEIGHBOURS) break;
            const b = scene.getInstancedEntityBounds(id);
            if (!b || b.min.x > p.x + r || b.max.x < p.x - r || b.min.y > p.y + r || b.max.y < p.y - r
              || b.min.z > p.z + r || b.max.z < p.z - r || this.owner(id) !== modelId) continue;
            instancedIds.add(id);
          }
          // The hit is in the placed scene frame; directory bounds are model-local sources.
          const [dx, dy, dz] = modelOffset(scene, hit.modelIndex);
          const lx = p.x - dx, ly = p.y - dy, lz = p.z - dz;
          const chunks = backing.directory.chunksIntersecting([lx - r, ly - r, lz - r], [lx + r, ly + r, lz + r]);
          let bytes = 0;
          const within = chunks.filter((index) => (bytes += backing.directory.chunks[index].bytes) <= this.budgetBytes);
          leases.push(await backing.reader.leaseChunks(within, { signal }));
        }
        instanced = await readInstancedOccurrences(backing, instancedIds, hit.modelIndex ?? 0, { signal });
        if (own.meshes.length === 0 && !instanced.some((mesh) => mesh.expressId === hit.expressId)) {
          throw new GeometryUnavailableError(`Instanced entity ${hit.expressId} has no backed opaque occurrence`);
        }
        signal.throwIfAborted();
      } catch (error) {
        for (const lease of leases) lease.release();
        throw error;
      }
      const seen = new Set<MeshData>();
      const meshes: MeshData[] = [];
      for (const lease of leases) for (const mesh of lease.meshes) {
        if (seen.has(mesh)) continue;
        seen.add(mesh);
        // Only what the scene draws: the store also holds type-filtered meshes
        // (spaces, openings) and class-2 type templates the scene never had.
        if ((mesh.geometryClass ?? 0) === 2 || scene.getEntityBoundingBox(mesh.expressId) === null) continue;
        meshes.push(place(scene, mesh));
      }
      // Occurrences are model-local like flat sources; the same placement applies.
      for (const mesh of instanced) meshes.push(place(scene, mesh));
      this.swap(leases, meshes, { x, y });
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

  private swap(leases: MeshLease[], meshes: MeshData[], at?: { x: number; y: number }): void {
    this.host.setReadbackRaycastMeshes(meshes.length > 0 ? meshes : null, at);
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
