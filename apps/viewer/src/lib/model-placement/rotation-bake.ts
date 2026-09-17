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
 * TWO ORDERING CONTRACTS, both load-bearing:
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
 * Nothing here relies on the identity of the geometry OBJECT. Streaming
 * (`appendGeometryBatch`) pushes meshes onto the live array and republishes it
 * under a new object without bumping the version, so a new object can carry
 * already-baked meshes; a collab replacement carries none of them. Baselines
 * are therefore keyed by MESH identity: a replacement is the case where no mesh
 * is known, an append the case where some are, and a mesh that is not in the
 * baseline has never been baked. That is what keeps rotating from compounding
 * on geometry that streams in after the user has set an angle.
 *
 * Baselines cost a copy of a model's position and normal buffers, so one is
 * captured only when a model is actually rotated and released the moment its
 * rotation returns to zero.
 */

import type { GeometryResult } from '@ifc-lite/geometry';
import {
  applyModelRotation, baselineIsForeign, captureAppendedMeshBaselines, captureRotationBaseline,
  type RotationBaseline,
} from './rotation-geometry.js';
import { equalRotation, isZeroRotation, ZERO_ROTATION, type ModelRotation } from './rotation.js';

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
