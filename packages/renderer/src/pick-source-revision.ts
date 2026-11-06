/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { PointCloudAssetHandle, PointCloudRenderer, PointCloudRenderOptions } from './pointcloud/point-cloud-renderer.js';
import type { SourceSnapCurve } from './source-curve-snap.js';
import type { PointCloudAsset } from '@ifc-lite/geometry';

/** Same points, same pick identity: the viewer re-stamps `modelIndex` into a fresh object on every merge. */
type EmbeddedKey = readonly [PointCloudAsset['chunk'], number, number];
const embeddedKey = (a: PointCloudAsset): EmbeddedKey => [a.chunk, a.expressId, a.modelIndex ?? 0];

/** What identifies a curve's snap points: its authored identity and where it evaluates. */
function curveSetKey(curves: readonly SourceSnapCurve[]): string {
  return JSON.stringify(curves.map((c) => [c.identity, c.globalId, c.kind, c.length, c.sweepAngle ?? null,
    c.affineDisplayFrame ?? null, c.bounds ?? null, c.pointAt(0), c.pointAt(0.5), c.pointAt(1)]));
}

/** The matrices a ray query reads for one asset (`placement ?? model`). */
function placementKey(points: PointCloudRenderer, handle: PointCloudAssetHandle): string {
  return JSON.stringify([Array.from(points.getAssetPlacement(handle) ?? []), Array.from(points.getAssetTransform(handle) ?? [])]);
}

function sameMask(a: Uint32Array, b: Uint32Array): boolean {
  return a.length === b.length && a.every((word, i) => word === b[i]);
}

/**
 * The pick sources outside the Scene that the magnetic pick also snaps to:
 * point clouds (#9029) and the source snap curves a selection installs
 * (#9030). `Renderer.getPickGeometryRevision()` folds `revision()` into the
 * Scene's revision, so the viewer's Measure Point "Live" reading (#8998)
 * ends when either changes what a pick at a resting cursor would return.
 * Both counters only grow, so their sum with the Scene's only changes on a
 * real change.
 */
export class PickSourceRevision {
  private pointClouds = 0;
  /** The IFCx list `setPointClouds` last installed; null once anything else changed the embedded clouds. */
  private embedded: readonly EmbeddedKey[] | null = [];
  private curves = 0;
  private curveKey = curveSetKey([]);
  private readCurveKey = this.curveKey;

  /** Points were added, removed, moved, shown, hidden or relabelled. */
  notePointClouds(): void { this.pointClouds++; }

  /** Embedded clouds were added outside `setPointClouds`, or every cloud was cleared (`[]`). */
  noteEmbeddedChanged(now: readonly PointCloudAsset[] | null = null): void { this.embedded = now?.map(embeddedKey) ?? null; this.pointClouds++; }

  /**
   * The viewer re-pushes the IFCx list on every model-list change, often the
   * same assets or none at all; only a different list changes what a snap can hit.
   */
  setEmbeddedClouds(points: PointCloudRenderer, assets: readonly PointCloudAsset[]): void {
    const last = this.embedded;
    try {
      points.setAssets(assets);
    } catch (error) {
      this.noteEmbeddedChanged(); // the old clouds are gone and the new ones half-uploaded
      throw error;
    }
    const now = assets.map(embeddedKey);
    if (last && last.length === now.length && now.every((key, i) => key.every((part, j) => part === last[i][j]))) return;
    this.noteEmbeddedChanged(assets);
  }

  /** Runs `place`; counts only when the matrices the ray query reads moved (the placement sync re-pushes unchanged ones). */
  placePointCloud(points: PointCloudRenderer, handle: PointCloudAssetHandle, place: () => void): void {
    const before = placementKey(points, handle);
    place();
    if (placementKey(points, handle) !== before) this.pointClouds++;
  }

  /** Applies `opts`; only a changed class mask filters what a snap can hit. */
  setPointCloudOptions(points: PointCloudRenderer, opts: PointCloudRenderOptions): void {
    const before = points.getOptions().classMask;
    points.setOptions(opts);
    if (!sameMask(before, points.getOptions().classMask)) this.pointClouds++;
  }

  /**
   * The overlay re-installs curves (clearing them first) on every selection
   * change, so this compares the set's content, not its identity, and the
   * revision moves only once a read sees a different set than the last read.
   */
  noteCurves(curves: readonly SourceSnapCurve[]): void { this.curveKey = curveSetKey(curves); }

  revision(): number {
    if (this.curveKey !== this.readCurveKey) { this.readCurveKey = this.curveKey; this.curves++; }
    return this.pointClouds + this.curves;
  }
}
