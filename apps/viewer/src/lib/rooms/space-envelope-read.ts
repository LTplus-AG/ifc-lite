/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ModelEditTarget } from '@/store/slices/mutation-modelling-records';
import { asExpressIdRef as ref, asCoordinateTriple, readAttributes, resolvePlacementChain } from '@/lib/placement-core';
import { resolveSlabEditChain, type SlabEditChain } from '@/lib/slab-edit';
import { getModelLengthUnitScale } from '@/lib/length-unit-scale';
import { effectiveStoreyId } from '@/lib/effective-storey';
import { axis3d } from '../../../../../packages/create/src/in-store/host-geometry-frame';
import { envelopeMeasures, type CeilingPlane, type SpaceEnvelope } from './space-envelope';

export interface SpaceEnvelopeTarget {
  modelId: string;
  expressId: number;
  storeyId: number;
  chain: SlabEditChain & { baseElevation: number };
  envelope: SpaceEnvelope;
  productShape: unknown[];
  shapeRep: unknown[];
}

/** Refuse unreadable, mapped, multi-item, tilted, holed and non-planar
 * sources before writing. The bounded iterative clipping walk also reads saved
 * envelopes, so re-editing after a reload uses the same path as the first edit. */
export function readSpaceEnvelope(target: ModelEditTarget, expressId: number): SpaceEnvelopeTarget | null {
  const { modelId, dataStore, view, editor } = target;
  const type = (id: number | null) => id === null ? '' : editor.getEntityType(id)?.toUpperCase();
  const read = (id: number | null) => id === null || view.isDeleted(id) ? null : readAttributes(dataStore, view, editor, id);
  if (type(expressId) !== 'IFCSPACE' || view.isDeleted(expressId)) return null;
  const storeyId = effectiveStoreyId(dataStore, view, expressId);
  if (storeyId === undefined) return null;
  const placement = resolvePlacementChain(dataStore, view, editor, expressId);
  const storeyPlacement = ref(read(storeyId)?.[5]);
  // The reused slab reader measures the immediate placement in the storey's
  // frame. An extra building/element parent would need a full relative transform.
  if (!placement || ref(read(placement.localPlacementId)?.[0]) !== storeyPlacement || storeyPlacement === null) return null;
  const productShapeId = ref(read(expressId)?.[6]);
  if (type(productShapeId) !== 'IFCPRODUCTDEFINITIONSHAPE') return null;
  const productShape = read(productShapeId);
  const reps = productShape?.[2];
  if (!productShape || !Array.isArray(reps) || reps.length === 0) return null;
  const shapeRepId = ref(reps[0]);
  if (type(shapeRepId) !== 'IFCSHAPEREPRESENTATION') return null;
  const shapeRep = read(shapeRepId);
  if (!shapeRep || shapeRep[1] !== 'Body' || !Array.isArray(shapeRep[3]) || shapeRep[3].length !== 1) return null;
  if (!['IFCGEOMETRICREPRESENTATIONCONTEXT', 'IFCGEOMETRICREPRESENTATIONSUBCONTEXT'].includes(type(ref(shapeRep[0])) ?? '')) return null;
  let item = ref(shapeRep[3][0]);
  const visited = new Set<number>();
  const ceiling: CeilingPlane[] = [];
  const k = getModelLengthUnitScale(dataStore);
  const reader = { entity(id: number) { const attributes = read(id); const t = editor.getEntityType(id); return attributes && t ? { type: t, attributes } : null; } };
  while (type(item) === 'IFCBOOLEANCLIPPINGRESULT') {
    if (item === null || visited.has(item) || visited.size >= 2) return null;
    visited.add(item);
    const attrs = read(item);
    if (!attrs || String(attrs[0]).replaceAll('.', '').toUpperCase() !== 'DIFFERENCE') return null;
    const halfId = ref(attrs[2]), half = read(halfId);
    if (type(halfId) !== 'IFCHALFSPACESOLID' || !half || ![false, '.F.', 'F'].includes(half[1] as string | boolean)) return null;
    const planeId = ref(half[0]), plane = read(planeId);
    if (type(planeId) !== 'IFCPLANE' || !plane) return null;
    const frame = axis3d(reader, plane[0]);
    if (!frame || frame.z[2] < 1e-6) return null;
    const a = -frame.z[0] / frame.z[2], b = -frame.z[1] / frame.z[2];
    ceiling.push({ a, b, c: (frame.o[2] - a * frame.o[0] - b * frame.o[1]) * k });
    item = ref(attrs[1]);
  }
  if (item === null || type(item) !== 'IFCEXTRUDEDAREASOLID') return null;
  const solid = read(item), profileId = ref(solid?.[0]), profile = read(profileId);
  if (!profile || !['IFCRECTANGLEPROFILEDEF', 'IFCARBITRARYCLOSEDPROFILEDEF'].includes(type(profileId) ?? '')) return null;
  if (String(profile[0]).replaceAll('.', '').toUpperCase() !== 'AREA') return null;
  // The shared footprint reader doesn't carry rotated rectangle Profile.Position.
  if (type(profileId) === 'IFCRECTANGLEPROFILEDEF') {
    if (!(typeof profile[3] === 'number' && profile[3] > 0 && typeof profile[4] === 'number' && profile[4] > 0)) return null;
    if (profile[2] != null) {
      const posId = ref(profile[2]), pos = read(posId);
      const pointId = ref(pos?.[0]), coordinates = asCoordinateTriple(read(pointId)?.[0]);
      const dir = pos?.[1] == null ? [1, 0] : read(ref(pos[1]))?.[0];
      if (type(posId) !== 'IFCAXIS2PLACEMENT2D' || type(pointId) !== 'IFCCARTESIANPOINT'
        || !coordinates?.every(Number.isFinite) || Math.abs(coordinates[2]) > 1e-9
        || !Array.isArray(dir) || !dir.every(Number.isFinite) || dir[0] <= 0 || Math.abs(dir[1]) > 1e-9) return null;
    }
  } else {
    const curveId = ref(profile[2]), refs = read(curveId)?.[0];
    if (type(curveId) !== 'IFCPOLYLINE' || !Array.isArray(refs) || refs.length < 3 || refs.length > 257) return null;
    for (const value of refs) {
      const id = ref(value), point = asCoordinateTriple(read(id)?.[0]);
      if (type(id) !== 'IFCCARTESIANPOINT' || !point?.every(Number.isFinite) || Math.abs(point[2]) > 1e-9) return null;
    }
  }
  const chain = resolveSlabEditChain(dataStore, view, editor, expressId, k, item);
  if (!chain || chain.baseElevation === null || !chain.extrusionUp || chain.thickness <= 0) return null;
  // Half-space positions are in the element frame, while footprints are storey-local.
  const [x, y, z] = chain.placementOrigin;
  const top = chain.baseElevation + chain.thickness;
  const envelope = { floor: chain.baseElevation, ceiling: ceiling.length
    ? [...ceiling.map(p => ({ ...p, c: p.c + z - p.a * x - p.b * y })), { a: 0, b: 0, c: top }]
    : [{ a: 0, b: 0, c: top }] };
  // The extrusion must completely cover the clipped top. Otherwise three
  // faces describe it and the two-face UI would lose the horizontal cap.
  if (ceiling.length && chain.footprint.some(p => Math.min(...envelope.ceiling.slice(0, -1).map(q => q.a * p[0] + q.b * p[1] + q.c)) > top + 1e-6)) return null;
  if (ceiling.length) envelope.ceiling.pop();
  const measures = envelopeMeasures(chain.footprint, envelope);
  if (!measures || measures.height > chain.thickness + 1e-6) return null;
  return { modelId, expressId, storeyId, chain: { ...chain, baseElevation: chain.baseElevation }, envelope, productShape, shapeRep };
}
