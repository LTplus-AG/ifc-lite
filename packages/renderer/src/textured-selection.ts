/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { MeshData } from '@ifc-lite/geometry';
import type { Scene } from './scene.js';
import type { TexturedMesh } from './textured-drawable.js';
import type { Mesh } from './types.js';
import type { RenderPipeline } from './pipeline.js';
import { MathUtils } from './math.js';
import { meshUniformArena, stageMeshUniforms, type MeshUniformSlot } from './mesh-uniform-arena.js';
import { recordSelectionSource, selectionDrawSpan, selectionHydrationOrder } from './selection-hydration-order.js';

export interface TexturedSelectionResources {
  device: GPUDevice;
  pipeline: Pick<RenderPipeline, 'getUniformBufferSize' | 'getBindGroupLayout'>;
}
const borrowedSlots = new WeakMap<Mesh, MeshUniformSlot>();
export function isBorrowedSelection(mesh: Mesh): boolean { return borrowedSlots.has(mesh); }
export function stageBorrowedSelection(mesh: Mesh, uniforms: Float32Array): boolean {
  const slot = borrowedSlots.get(mesh);
  if (!slot) return false;
  stageMeshUniforms(slot, uniforms);
  return true;
}
export function isTexturedPiece(piece: MeshData): boolean {
  return !!(piece.uvs && (piece.texture || (piece.textureRef && piece.textureBitmap)));
}

/** Non-owning draw records: never inserted into Scene.meshes or freed as geometry. */
export class TexturedSelection {
  private entries = new Map<TexturedMesh, { mesh: Mesh; slot: MeshUniformSlot }>();
  private device?: GPUDevice;
  private ranks: number[] = [];

  sync(scene: Scene, visible: ReadonlySet<number>, resources: TexturedSelectionResources, model?: number, itemExpressId?: number, itemId?: number, selected: ReadonlySet<number> = visible): Mesh[] {
    if (this.device !== resources.device) { this.clear(); this.device = resources.device; }
    const order = selectionHydrationOrder(scene);
    const active = new Set<TexturedMesh>();
    const draws: Mesh[] = [];
    this.ranks = [];
    const texturedIds = new Set<number>();
    for (const id of visible) {
      const pieces = scene.getMeshDataPieces(id, model, id === itemExpressId ? itemId : undefined) ?? [];
      order.remember(pieces);
      if (pieces.some(isTexturedPiece)) texturedIds.add(id);
      for (const piece of pieces) {
        const source = scene.getTexturedDrawable(piece);
        if (!source || active.has(source)) continue;
        active.add(source);
        let entry = this.entries.get(source);
        if (!entry) {
          const slot = meshUniformArena(resources.device, resources.pipeline.getUniformBufferSize()).allocate();
          try {
            const bindGroup = resources.device.createBindGroup({ layout: resources.pipeline.getBindGroupLayout(),
              entries: [{ binding: 0, resource: { buffer: slot.buffer, offset: slot.offset, size: slot.size } }] });
            const mesh: Mesh = { expressId: piece.expressId, modelIndex: piece.modelIndex, geometryItemId: piece.geometryItemId,
              vertexBuffer: source.vertexBuffer, indexBuffer: source.indexBuffer, indexCount: source.indexCount,
              color: piece.color, transform: MathUtils.identity(), uniformBuffer: slot.buffer, bindGroup,
              ...(piece.material ? { finish: piece.material } : {}) };
            entry = { mesh, slot }; borrowedSlots.set(mesh, slot); this.entries.set(source, entry);
          } catch (error) { slot.release(); throw error; }
        }
        const mesh = entry.mesh;
        mesh.rteOrigin = [...source.origin];
        mesh.transform.m[12] = source.origin[0]; mesh.transform.m[13] = source.origin[1]; mesh.transform.m[14] = source.origin[2];
        recordSelectionSource(scene, mesh, piece);
        draws.push(mesh); this.ranks.push(order.rank(piece));
      }
    }
    const live = new Set(scene.getTexturedMeshes());
    for (const [source, entry] of this.entries) {
      const mesh = entry.mesh;
      const retained = live.has(source) && selected.has(mesh.expressId)
        && (model === undefined || mesh.modelIndex === model)
        && (mesh.expressId !== itemExpressId || mesh.geometryItemId === itemId);
      if (!retained) { entry.slot.release(); this.entries.delete(source); continue; }
      // CPU release does not retire live GPU geometry. Keep the existing draw
      // and its numeric rank without retaining or reconstructing CPU meshes.
      if (!active.has(source)) {
        // Hidden selections keep their pool barriers: after CPU release a
        // flat pool cannot be rebuilt merely to insert a returning texture.
        const span = selectionDrawSpan(mesh);
        if (span) this.ranks.push(span.first);
        if (scene.isGeometryDataReleased() && visible.has(mesh.expressId)) {
          mesh.rteOrigin = [...source.origin];
          mesh.transform.m[12] = source.origin[0]; mesh.transform.m[13] = source.origin[1]; mesh.transform.m[14] = source.origin[2];
          draws.push(mesh);
        }
      }
    }
    this.ranks.sort((a, b) => a - b);
    // A GPU pick may have hydrated a texture before it became selected. Its
    // copy is no longer needed; mixed entities rehydrate only their flat parts.
    const crossing = new Set(scene.getMeshes().filter((mesh) => {
      const span = selectionDrawSpan(mesh);
      if (!span || !mesh.mergedSelection) return false;
      let lo = 0, hi = this.ranks.length;
      while (lo < hi) { const mid = (lo + hi) >>> 1; if (this.ranks[mid] <= span.first) lo = mid + 1; else hi = mid; }
      return lo < this.ranks.length && this.ranks[lo] < span.last;
    }).map((mesh) => mesh.mergedSelection));
    scene.removeMeshesWhere((mesh) => !!(mesh.mergedSelection && crossing.has(mesh.mergedSelection))
      || (mesh.hydrated === true && !mesh.mergedSelection && texturedIds.has(mesh.expressId)));
    return draws;
  }

  /** Never merge a colour run across a borrowed draw: that would change triangle order. */
  runs(scene: Scene, pieces: readonly MeshData[]): MeshData[][] {
    const order = selectionHydrationOrder(scene);
    const runs: MeshData[][] = [];
    let previous = -Infinity, cursor = 0;
    for (const piece of pieces) {
      const rank = order.rank(piece);
      while (cursor < this.ranks.length && this.ranks[cursor] <= previous) cursor++;
      if (runs.length === 0 || (cursor < this.ranks.length && this.ranks[cursor] < rank)) runs.push([]);
      runs[runs.length - 1].push(piece); previous = rank;
    }
    return runs;
  }

  clear(): void { for (const { slot } of this.entries.values()) slot.release(); this.entries.clear(); this.ranks = []; }
}
