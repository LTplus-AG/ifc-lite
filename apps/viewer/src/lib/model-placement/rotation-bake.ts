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
 *  1. **Nothing else may rewrite a rotated model's vertices.** The only things
 *     that do are a federation re-align and a collab model replacement. The
 *     re-align path must call {@link ModelRotationBaker.unbake} BEFORE it
 *     snapshots or restores anything, so a rotation can never end up baked
 *     inside a `preAlignment` snapshot — a snapshot that contained one would
 *     restore *to* a rotated state and the next bake would compound it. A
 *     collab replacement hands over a new geometry object, which this detects
 *     by identity.
 *
 *  2. **A bump this baker did not cause invalidates every baseline.** Together
 *     with (1) that is sound: an external rewrite always leaves the geometry
 *     un-rotated, so re-capturing from it and re-applying the declared angle
 *     lands in the right place. Hence {@link ModelRotationBaker.settle}, which
 *     the caller uses to say "this bump was mine".
 *
 * Baselines cost a copy of a model's position and normal buffers, so one is
 * captured only when a model is actually rotated and released the moment its
 * rotation returns to zero.
 */

import type { GeometryResult } from '@ifc-lite/geometry';
import { applyModelRotation, captureRotationBaseline, type RotationBaseline } from './rotation-geometry.js';
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
  version: number;
}

export class ModelRotationBaker {
  private entries = new Map<string, Entry>();

  /**
   * Bring every target's geometry to its declared rotation.
   *
   * @param contentVersion the store's current geometry content version.
   * @returns the ids whose vertices this call actually moved — what the caller
   *   must bump the content version for and re-index.
   */
  reconcile(targets: ReadonlyMap<string, RotationTarget>, contentVersion: number): string[] {
    const moved: string[] = [];
    for (const [modelId, target] of targets) {
      const geometry = target.geometry;
      if (!geometry || geometry.meshes.length === 0) continue;
      let entry = this.entries.get(modelId);
      if (entry && (entry.geometry !== geometry || entry.version !== contentVersion)) {
        // The vertices this baseline described are gone — the model was
        // replaced, or something outside this baker rewrote them. It can no
        // longer restore anything, so it must not be used to.
        this.entries.delete(modelId);
        entry = undefined;
      }
      if (!entry) {
        // No baseline is captured for an unrotated model: that is the common
        // case and a baseline is a copy of the whole geometry.
        if (isZeroRotation(target.rotation)) continue;
        entry = { geometry, baseline: captureRotationBaseline(geometry), applied: ZERO_ROTATION, version: contentVersion };
        this.entries.set(modelId, entry);
      }
      if (equalRotation(entry.applied, target.rotation)) continue;
      applyModelRotation(geometry, entry.baseline, target.rotation);
      moved.push(modelId);
      // Back at zero the geometry is the baseline, so holding the copy buys
      // nothing and costs a model's worth of buffers.
      if (isZeroRotation(target.rotation)) this.entries.delete(modelId);
      else entry.applied = { angle: target.rotation.angle, pivot: [...target.rotation.pivot] };
    }
    return moved;
  }

  /** Record that `version` is the bump this baker's own bake caused, so the
   * next reconcile does not read it as somebody else's rewrite. */
  settle(version: number): void {
    for (const entry of this.entries.values()) entry.version = version;
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
