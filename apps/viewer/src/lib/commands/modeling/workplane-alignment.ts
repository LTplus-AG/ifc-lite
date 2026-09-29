/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Same-CRS federation alignment for the storey workplane (charter #6232,
 * WP2). A same-CRS model's vertices were moved into the anchor's render frame
 * by one affine at load (`alignGeometryToReference`); the transform itself is
 * not kept, so it is rebuilt from the same inputs and then CHECKED against
 * the vertices the load actually moved (`preAlignment` vs the live mesh). A
 * rebuilt transform that does not reproduce them — the anchor changed since,
 * a georeference edit — is refused rather than trusted.
 */

import type { CoordinateInfo } from '@ifc-lite/geometry';
import type { ViewerState } from '@/store';
import type { Vec3 } from './types.js';
import { extractModelSpatialPlacement, findReferenceSpatialModel } from '@/hooks/ingest/federationAlign';
import { buildSpatialAlignmentTransform } from '@/hooks/ingest/federationSpatialTransform';
import type { AffineTransform3D } from '@/hooks/ingest/federationAlignAabb';

export type Affine = AffineTransform3D;

/** How far (metres) the rebuilt transform may miss the load's own result. */
const VERIFY_TOLERANCE = 1e-3;

export function applyAffine(t: Affine, p: Vec3): Vec3 {
  return [
    t.m00 * p[0] + t.m01 * p[1] + t.m02 * p[2] + t.tx,
    t.m10 * p[0] + t.m11 * p[1] + t.m12 * p[2] + t.ty,
    t.m20 * p[0] + t.m21 * p[1] + t.m22 * p[2] + t.tz,
  ];
}

export function invertAffine(t: Affine): Affine | null {
  const det = t.m00 * (t.m11 * t.m22 - t.m12 * t.m21)
    - t.m01 * (t.m10 * t.m22 - t.m12 * t.m20)
    + t.m02 * (t.m10 * t.m21 - t.m11 * t.m20);
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  const i = 1 / det;
  const m00 = (t.m11 * t.m22 - t.m12 * t.m21) * i, m01 = (t.m02 * t.m21 - t.m01 * t.m22) * i, m02 = (t.m01 * t.m12 - t.m02 * t.m11) * i;
  const m10 = (t.m12 * t.m20 - t.m10 * t.m22) * i, m11 = (t.m00 * t.m22 - t.m02 * t.m20) * i, m12 = (t.m02 * t.m10 - t.m00 * t.m12) * i;
  const m20 = (t.m10 * t.m21 - t.m11 * t.m20) * i, m21 = (t.m01 * t.m20 - t.m00 * t.m21) * i, m22 = (t.m00 * t.m11 - t.m01 * t.m10) * i;
  return {
    m00, m01, m02, tx: -(m00 * t.tx + m01 * t.ty + m02 * t.tz),
    m10, m11, m12, ty: -(m10 * t.tx + m11 * t.ty + m12 * t.tz),
    m20, m21, m22, tz: -(m20 * t.tx + m21 * t.ty + m22 * t.tz),
  };
}

/** The alignment a same-CRS model was loaded through, and the frame it came from; null if not reproducible. */
export function sameCrsAlignment(
  s: ViewerState,
  modelId: string,
): { transform: Affine; sourceFrame: CoordinateInfo } | null {
  const model = s.models.get(modelId);
  const snapshot = model?.preAlignment;
  const store = model?.ifcDataStore;
  const meshes = model?.geometryResult?.meshes;
  if (!snapshot || !store || !meshes) return null;
  const reference = findReferenceSpatialModel();
  if (!reference || reference.modelId === modelId) return null;
  const source = extractModelSpatialPlacement(store, snapshot.coordinateInfo, s.georefMutations.get(modelId));
  if (!source) return null;
  const transform = buildSpatialAlignmentTransform(source, reference.placement);
  if (!transform || !invertAffine(transform)) return null;
  const index = meshes.findIndex((mesh, i) => mesh.positions.length >= 3 && (snapshot.positions[i]?.length ?? 0) >= 3);
  if (index < 0) return null;
  const at = (positions: ArrayLike<number>, origin: readonly number[] | undefined): Vec3 =>
    [positions[0] + (origin?.[0] ?? 0), positions[1] + (origin?.[1] ?? 0), positions[2] + (origin?.[2] ?? 0)];
  const predicted = applyAffine(transform, at(snapshot.positions[index], snapshot.origins[index]));
  const actual = at(meshes[index].positions, meshes[index].origin);
  const miss = Math.hypot(predicted[0] - actual[0], predicted[1] - actual[1], predicted[2] - actual[2]);
  return miss <= VERIFY_TOLERANCE ? { transform, sourceFrame: snapshot.coordinateInfo } : null;
}
