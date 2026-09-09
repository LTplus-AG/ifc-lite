/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { transformAabb, type PointCloudNode } from './point-cloud-node.js';

type Translation = readonly [number, number, number];
interface Placement { baseline: Float64Array; translation: Translation }
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** Compose import alignment and manual placement through one writer. In particular
 * toggling alignment must never erase a manual correction (#4226). */
export class PointCloudPlacements {
  private placements = new WeakMap<PointCloudNode, Placement>();

  private entry(node: PointCloudNode): Placement {
    let entry = this.placements.get(node);
    if (!entry) {
      entry = { baseline: new Float64Array(node.model ?? IDENTITY), translation: [0, 0, 0] };
      this.placements.set(node, entry);
    }
    return entry;
  }

  align(node: PointCloudNode, matrix: Float32Array | Float64Array | null): void {
    if (matrix && (matrix.length !== 16 || !matrix.every(Number.isFinite))) {
      throw new Error('Pointcloud placement needs a finite 4×4 matrix.');
    }
    const entry = this.entry(node);
    const next = { ...entry, baseline: new Float64Array(matrix ?? IDENTITY) };
    this.apply(node, next);
    this.placements.set(node, next);
  }

  translate(node: PointCloudNode, translation: Translation): void {
    if (translation.length !== 3 || !translation.every(Number.isFinite)) {
      throw new Error('Pointcloud translation needs three finite coordinates.');
    }
    const entry = this.entry(node);
    const next = { ...entry, translation: [...translation] as Translation };
    this.apply(node, next);
    this.placements.set(node, next);
  }

  private apply(node: PointCloudNode, entry: Placement): void {
    const matrix = new Float32Array(entry.baseline);
    for (let axis = 0; axis < 3; axis++) {
      // Sum in f64 FIRST. Narrowing the baseline at map magnitude would lose
      // the millimetres before a coarse move can bring the cloud near zero.
      matrix[12 + axis] = entry.baseline[12 + axis] + entry.translation[axis];
    }
    if (!matrix.every(Number.isFinite)) throw new Error('Pointcloud placement exceeds the renderable coordinate range.');
    node.model = matrix;
  }
}

/** Shared world-space bounds for whole-scene fitting and model-specific framing. */
export function unionPointCloudBounds(nodes: Iterable<PointCloudNode | undefined>) {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const node of nodes) {
    if (!node || node.pointCount === 0) continue;
    const bounds = transformAabb(node.bounds, node.model);
    if (![...bounds.min, ...bounds.max].every(Number.isFinite)) continue;
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis], bounds.min[axis]);
      max[axis] = Math.max(max[axis], bounds.max[axis]);
    }
  }
  return Number.isFinite(min[0]) ? { min, max } : null;
}
