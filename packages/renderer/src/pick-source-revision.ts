/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { PointCloudRenderer, PointCloudRenderOptions } from './pointcloud/point-cloud-renderer.js';
import type { SourceSnapCurve } from './source-curve-snap.js';

/** What identifies a curve's snap points: its authored identity and where it evaluates. */
function curveSetKey(curves: readonly SourceSnapCurve[]): string {
  return JSON.stringify(curves.map((c) => [c.identity, c.globalId, c.kind, c.length, c.sweepAngle ?? null,
    c.affineDisplayFrame ?? null, c.bounds ?? null, c.pointAt(0), c.pointAt(0.5), c.pointAt(1)]));
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
  private curves = 0;
  private curveKey = curveSetKey([]);
  private readCurveKey = this.curveKey;

  /** Points were added, removed, moved, shown, hidden or relabelled. */
  notePointClouds(): void { this.pointClouds++; }

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
