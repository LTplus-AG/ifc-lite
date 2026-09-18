/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Keeping each model's geometry in the state its placement's rotation declares.
 *
 * The placement state is the single source of truth for a heading; this is the
 * one place that makes the vertices agree with it. Committing, undoing,
 * redoing, importing and resetting all move the same declared value, so all
 * five arrive here and none needs its own geometry path.
 *
 * THREE ORDERING CONTRACTS, all load-bearing:
 *
 *  1. **Nothing else may rewrite a rotated model's vertices IN PLACE without
 *     bumping the content version.** A federation re-align must call
 *     {@link ModelRotationBaker.unbake} BEFORE it snapshots or restores
 *     anything, so a rotation can never end up baked inside a `preAlignment`
 *     snapshot — a snapshot that contained one would restore *to* a rotated
 *     state and the next bake would compound it.
 *
 *  2. **A baseline is invalidated per model, by that model's own meshes, and
 *     never by the store-wide `geometryContentVersion`.** That counter is
 *     shared: a collab update to ONE model bumps it for all of them, and
 *     reading every bump as a rewrite of every model would re-capture an
 *     untouched model's already-rotated vertices as "pristine" and turn it a
 *     second time. The only in-place rewrite of existing meshes is a re-align,
 *     which (1) already brackets.
 *
 *  3. **An operation that moves a model's RENDER FRAME rather than its geometry
 *     must move the baseline with it**, by calling {@link
 *     ModelRotationBaker.rebaseFrame} before it republishes the model. The
 *     federation RTC convergence (`hooks/ingest/federationRtcRebase.ts`, #4897)
 *     is that operation: it shifts each mesh's f64 `origin` and the
 *     `CoordinateInfo` anchor and leaves `positions` untouched, so contract (1)
 *     does not catch it — the vertices never change and un-baking around it
 *     would be wrong anyway, because a yaw and a pure translation commute and
 *     the already-baked heading rides along correctly. What does NOT ride along
 *     is the pristine copy: a baseline taken in the pre-convergence frame would
 *     restore pre-convergence origins, dropping the model back out of the
 *     shared frame on the next heading edit. The stored PIVOT is frame-relative
 *     for the same reason and is rebased beside it
 *     (`modelPlacementSlice.rebasePlacementFrame`).
 *
 * Nothing here relies on the identity of the geometry OBJECT. Streaming
 * (`appendGeometryBatch`) pushes meshes onto the live array and republishes it
 * under a new object without bumping the version, so a new object can carry
 * already-baked meshes; a collab replacement carries none of them. Baselines
 * are therefore keyed by MESH identity: a replacement is the case where no mesh
 * is known, an append the case where some are, and a mesh that is not in the
 * baseline has never been baked. That is what keeps rotating from compounding
 * on geometry that streams in after the user has set an angle.
 *
 * THE COROLLARY FOR AUTHORING: a mesh appended to a rotated model must be in
 * the model's own UNROTATED frame, exactly like a streamed batch, because it
 * will be turned once on arrival. A mesh built from IFC parameters already is
 * (add-element, and the wall / slab split, which rebuild their halves through
 * `addWall` / `addSlab`). A mesh DERIVED from live vertices is not: those are
 * baked. Such a path reads its source through {@link ModelRotationBaker.inModelFrame}
 * rather than the live mesh — a copy of the live bytes would be turned twice.
 *
 * Baselines cost a copy of a model's position and normal buffers, so one is
 * captured only when a model is actually rotated and released the moment its
 * rotation returns to zero.
 */

import type { GeometryResult, MeshData, Vec3 } from '@ifc-lite/geometry';
import { applyModelRotation } from './rotation-geometry.js';
import {
  baselineIsForeign, captureAppendedMeshBaselines, captureRotationBaseline,
  pruneMeshBaselines, rebaseBaselineByRtcDelta,
  type MeshPrune, type RotationBaseline,
} from './rotation-baseline.js';
import { equalRotation, isZeroRotation, ZERO_ROTATION, type ModelRotation } from './rotation.js';
import { fromRenderTranslation, subtractTranslation } from './translation.js';

type Geometry = Pick<GeometryResult, 'meshes' | 'coordinateInfo' | 'instancedGeometryAabbs'>;

export interface RotationTarget {
  geometry: Geometry | null | undefined;
  rotation: ModelRotation;
}

interface Entry {
  geometry: Geometry;
  baseline: RotationBaseline;
  applied: ModelRotation;
}

export class ModelRotationBaker {
  private entries = new Map<string, Entry>();

  /**
   * Bring every target's geometry to its declared rotation.
   *
   * @returns the ids whose vertices this call actually moved — what the caller
   *   must bump the content version for and re-index.
   */
  reconcile(targets: ReadonlyMap<string, RotationTarget>): string[] {
    const moved: string[] = [];
    for (const [modelId, target] of targets) {
      const geometry = target.geometry;
      if (!geometry || geometry.meshes.length === 0) continue;
      let entry = this.entries.get(modelId);
      if (entry && baselineIsForeign(geometry, entry.baseline)) {
        // The meshes this baseline described are gone — the model was
        // replaced. It can no longer restore anything, so it must not be used to.
        this.entries.delete(modelId);
        entry = undefined;
      }
      let appended = false;
      if (!entry) {
        // No baseline is captured for an unrotated model: that is the common
        // case and a baseline is a copy of the whole geometry.
        if (isZeroRotation(target.rotation)) continue;
        entry = { geometry, baseline: captureRotationBaseline(geometry), applied: ZERO_ROTATION };
        this.entries.set(modelId, entry);
      } else {
        // A streamed batch appends to the SAME mesh array and republishes it as
        // a new object, so the object identity says nothing; the meshes do.
        // Baseline the pristine newcomers and re-bake, or they would stay
        // un-rotated while their neighbours are rotated.
        appended = captureAppendedMeshBaselines(geometry, entry.baseline);
        entry.geometry = geometry;
      }
      if (!appended && equalRotation(entry.applied, target.rotation)) continue;
      applyModelRotation(geometry, entry.baseline, target.rotation);
      moved.push(modelId);
      // Back at zero the geometry is the baseline, so holding the copy buys
      // nothing and costs a model's worth of buffers.
      if (isZeroRotation(target.rotation)) this.entries.delete(modelId);
      else entry.applied = { angle: target.rotation.angle, pivot: [...target.rotation.pivot] };
    }
    return moved;
  }

  /**
   * `mesh` as it stands in its model's own unrotated frame — what an authoring
   * path that derives new geometry from an existing element (duplicate) must
   * read, so the new mesh arrives pristine and is turned exactly once.
   *
   * The pristine bytes are read from the baseline, not recovered by rotating the
   * live vertices back: that is exact, and it is the same copy a zero angle
   * restores. A mesh no baseline describes has never been baked, so it is
   * returned as it is. Buffers are copies either way — the bake rewrites a
   * mesh's arrays in place, and a clone sharing them would be turned with it.
   */
  inModelFrame(mesh: MeshData): MeshData {
    for (const entry of this.entries.values()) {
      const pristine = entry.baseline.meshes.get(mesh);
      if (!pristine) continue;
      // A bounded-mode release emptied the live buffers; there is nothing to
      // clone, and handing back the baseline's vertices would resurrect them.
      if (mesh.positions.length !== pristine.positions.length) break;
      const out: MeshData = { ...mesh, positions: new Float32Array(pristine.positions),
        normals: pristine.normals ? new Float32Array(pristine.normals) : mesh.normals };
      if (pristine.origin) out.origin = [...pristine.origin]; else delete out.origin;
      if (pristine.localToWorld) out.localToWorld = [...pristine.localToWorld]; else delete out.localToWorld;
      if (pristine.geometryAabb) out.geometryAabb = pristine.geometryAabb; else delete out.geometryAabb;
      return out;
    }
    return { ...mesh, positions: new Float32Array(mesh.positions),
      normals: mesh.normals ? new Float32Array(mesh.normals) : mesh.normals };
  }

  /**
   * Put every rotated model back to its pristine geometry and forget the
   * baselines. Called before anything else re-bakes a model's vertices (see
   * contract 1); the declared rotations are untouched, so the next reconcile
   * re-applies them on top of whatever that operation produced.
   *
   * @returns the ids whose vertices this call moved.
   */
  unbake(geometryFor: (modelId: string) => Geometry | null | undefined): string[] {
    const moved: string[] = [];
    for (const [modelId, entry] of this.entries) {
      if (geometryFor(modelId) === entry.geometry && !isZeroRotation(entry.applied)) {
        applyModelRotation(entry.geometry, entry.baseline, ZERO_ROTATION);
        moved.push(modelId);
      }
    }
    this.entries.clear();
    return moved;
  }

  /**
   * Follow one model's live geometry onto a new RTC anchor (contract 3): the
   * federation convergence moved its meshes by `delta` without a bake, so the
   * pristine copy a later restore writes back has to move by the same delta.
   *
   * `applied` — the heading already standing in the vertices — is re-expressed
   * too. Its pivot is a render-frame point like the declared one the store
   * rebases alongside this, and leaving it in the old frame would make the two
   * disagree: `reconcile` would read that as a changed rotation and re-bake a
   * model that has not turned, costing a vertex pass and a GPU re-upload on
   * every convergence. The re-bake would land in the same place — a bake is
   * absolute — so this is about work, not correctness.
   *
   * A no-op for a model with no baseline, which is every un-rotated model.
   */
  rebaseFrame(modelId: string, delta: Readonly<Vec3>): void {
    const entry = this.entries.get(modelId);
    if (!entry) return;
    rebaseBaselineByRtcDelta(entry.baseline, delta);
    // Render frame to engineering workspace axes; a point moves by `-delta`,
    // like the origins the convergence shifts.
    const workspace = fromRenderTranslation(delta);
    entry.applied = { angle: entry.applied.angle,
      pivot: subtractTranslation(entry.applied.pivot, workspace) };
  }

  /**
   * Follow the store's mesh-removal drain: forget the meshes it just pruned out
   * of the live geometry (#4935).
   *
   * A split or a delete removes a mesh from `geometryResult.meshes`
   * (`pruneGeometryMeshes`), and the baseline is the one place that still holds
   * a pristine COPY of it plus its share of the pristine extent. Left alone, it
   * pins that memory, hands fit-to-view and the section calculations an extent
   * that still covers deleted geometry, and puts those bounds back on the next
   * zero-angle bake.
   *
   * Applied to EVERY baseline, like the prune itself: the drain carries
   * renderer global ids with no model id, and federated id ranges are disjoint,
   * so a model that owns none of them loses nothing.
   *
   * A no-op for an un-rotated model, which has no baseline at all.
   */
  pruneMeshes(prune: MeshPrune): void {
    for (const [modelId, entry] of this.entries) {
      pruneMeshBaselines(entry.geometry, entry.baseline, prune);
      // The prune republishes the geometry as a NEW object. Following it keeps
      // `unbake`'s identity check true across a delete, and keeps
      // `bakedInstanced` pointing at the map the geometry now carries — that
      // map holds the boxes this baker already baked, and read as pristine
      // (`captureAppendedMeshBaselines`) they would be turned a second time.
      const replacement = prune.replacements.get(entry.geometry);
      if (replacement) {
        entry.geometry = replacement;
        entry.baseline.bakedInstanced = replacement.instancedGeometryAabbs;
      }
      // Nothing left to restore: every mesh this baseline described is gone, so
      // holding it pins an extent that describes an empty model. The next
      // reconcile captures a fresh one from whatever the model still has.
      if (entry.baseline.meshes.size === 0) this.entries.delete(modelId);
    }
  }

  /** Drop one model's baseline without restoring anything — the model and its
   * geometry are going away together. */
  forget(modelId: string): void {
    this.entries.delete(modelId);
  }

  /** Drop every baseline without restoring anything — for a teardown where the
   * geometry is going away with them. */
  clear(): void {
    this.entries.clear();
  }
}

/** One baker per session: the baselines it holds are the only record of what a
 * rotated model's pristine vertices were. */
export const modelRotationBaker = new ModelRotationBaker();
