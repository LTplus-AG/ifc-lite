/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { ownReferencePdfLineage, type ReferencePdfLineage } from './pdf-lineage.js';
import type { PlaneCalibrationRequest } from '../plane-calibration.js';
import { ownCalibrationRecipe } from './calibration-recipe.js';

export type ReferencePoint = readonly [number, number, number];
export interface RegisteredAppearanceReference {
  readonly id: string;
  /** Source lineage; changing that source never repaints this committed reference. */
  readonly sourceId: string;
  /** Exact encoded-image digest, independent of the source's current raster. */
  readonly assetId: string;
  /** Canonical calibration order: top-left, top-right, bottom-right, bottom-left. */
  readonly cornersIfcWorld: readonly [ReferencePoint, ReferencePoint, ReferencePoint, ReferencePoint];
  readonly frameKey: string;
  readonly visible: boolean;
  readonly locked: boolean;
  readonly opacity: number;
  /** Frozen calibration recipe for explicit editing, independent of PDF bytes. */
  readonly calibration?: PlaneCalibrationRequest;
  readonly pdf?: ReferencePdfLineage;
}
export interface ReferenceCommand {
  readonly id: string;
  readonly timestamp: number;
  readonly before: ReadonlyMap<string, RegisteredAppearanceReference>;
  readonly after: ReadonlyMap<string, RegisteredAppearanceReference>;
}
export const MAX_REFERENCES = 256;
export const MAX_REFERENCE_HISTORY = 100;

function shortString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096;
}
/** Own all nested coordinates before publication; never retain caller-owned arrays. */
export function ownReference(value: unknown): RegisteredAppearanceReference {
  if (!value || typeof value !== 'object') throw new Error('Invalid drawing reference.');
  const v = value as Record<string, unknown>;
  if (!shortString(v.id) || !shortString(v.sourceId) || !shortString(v.frameKey)
    || typeof v.assetId !== 'string' || !/^[a-f0-9]{64}$/.test(v.assetId)
    || typeof v.visible !== 'boolean' || typeof v.locked !== 'boolean'
    || typeof v.opacity !== 'number' || !Number.isFinite(v.opacity) || v.opacity < 0 || v.opacity > 1
    || !Array.isArray(v.cornersIfcWorld) || v.cornersIfcWorld.length !== 4) {
    throw new Error('Invalid drawing reference metadata.');
  }
  const points = v.cornersIfcWorld.map((point: unknown) => {
    if (!Array.isArray(point) || point.length !== 3 || !point.every(n => typeof n === 'number' && Number.isFinite(n))) {
      throw new Error('Drawing reference corners require finite engineering coordinates.');
    }
    return Object.freeze([...point]) as ReferencePoint;
  });
  // The renderer validates its quad geometry too; registration rejects collapsed
  // corners without imposing a coordinate-magnitude-dependent f32 tolerance.
  const a = points[0], b = points[1], d = points[3];
  const u = b.map((n, i) => n - a[i]), w = d.map((n, i) => n - a[i]);
  const cross = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
  if (!cross.every(Number.isFinite) || !cross.some(n => n !== 0)) throw new Error('Drawing reference corners are degenerate.');
  const calibration = v.calibration === undefined ? undefined : ownCalibrationRecipe(v.calibration);
  return Object.freeze({ id: v.id, sourceId: v.sourceId, assetId: v.assetId,
    frameKey: v.frameKey, visible: v.visible, locked: v.locked, opacity: v.opacity,
    ...(calibration ? { calibration } : {}),
    ...(v.pdf === undefined ? {} : { pdf: ownReferencePdfLineage(v.pdf, calibration) }),
    cornersIfcWorld: Object.freeze(points) as RegisteredAppearanceReference['cornersIfcWorld'] });
}
