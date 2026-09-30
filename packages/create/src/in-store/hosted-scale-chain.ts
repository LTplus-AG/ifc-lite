/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #6232: repeated size commits must not grow a mapping chain until the
 * canonical renderer's reference-walk bound drops the occurrence. Collapse
 * only an existing anchored scale with the same rigid factorization; other
 * mappings remain untouched. No source/type entity is mutated. */
import type { AnchorEntityReader } from './resolve-anchor.js';
import { axis2d, axis3d, num, pointOf, refId, type Frame3, type Vec3 } from './host-geometry-frame.js';

export function retainedHostedScale(
  reader: AnchorEntityReader, repId: number, dimension: 2 | 3,
  inHost: Frame3, sourceAnchor: Vec3, inverse: Frame3, localAnchor: Vec3,
): { repId: number; width: number; height: number } | null {
  const rep = reader.entity(repId);
  const items = rep?.attributes[3];
  if (!Array.isArray(items) || items.length !== 1) return null;
  const itemId = refId(items[0]), item = itemId === null ? null : reader.entity(itemId);
  if (item?.type.toUpperCase() !== 'IFCMAPPEDITEM') return null;
  const mapId = refId(item.attributes[0]), targetId = refId(item.attributes[1]);
  const map = mapId === null ? null : reader.entity(mapId);
  const target = targetId === null ? null : reader.entity(targetId);
  if (map?.type.toUpperCase() !== 'IFCREPRESENTATIONMAP' || !target) return null;
  const originId = refId(map.attributes[0]);
  const mappingOrigin = originId === null ? null : reader.entity(originId);
  if (mappingOrigin?.type.toUpperCase() !== `IFCAXIS2PLACEMENT${dimension}D`) return null;
  const underlyingId = refId(map.attributes[1]);
  const underlying = underlyingId === null ? null : reader.entity(underlyingId);
  if (underlying?.type.toUpperCase() !== 'IFCSHAPEREPRESENTATION' || underlyingId === null
    || refId(underlying.attributes[0]) !== refId(rep?.attributes[0])) return null;
  // A style or presentation layer on the wrapper itself must remain in the
  // graph. Retaining that wrapper once still lets later plain scales compose.
  for (const id of reader.ids('IFCSTYLEDITEM')) {
    if (refId(reader.entity(id)?.attributes[0]) === itemId) return null;
  }
  for (const type of ['IFCPRESENTATIONLAYERASSIGNMENT', 'IFCPRESENTATIONLAYERWITHSTYLE']) {
    for (const id of reader.ids(type)) {
      const assigned = reader.entity(id)?.attributes[2];
      if (Array.isArray(assigned) && assigned.some(value => [itemId, repId].includes(refId(value)))) return null;
    }
  }

  // Directions only allow floating-point normalization noise. Origins use
  // a billionth of the native file unit; this is not a clipping tolerance.
  const same = (a: readonly number[], b: readonly number[], epsilon: number) =>
    a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= epsilon);
  const origin = pointOf(reader, target.attributes[2], 'IFCCARTESIANPOINT', dimension);
  const x = pointOf(reader, target.attributes[0], 'IFCDIRECTION', dimension);
  const y = pointOf(reader, target.attributes[1], 'IFCDIRECTION', dimension);
  if (!origin || !x || !y || !same(origin.slice(0, dimension), localAnchor.slice(0, dimension), 1e-9)
    || !same(x.slice(0, dimension), inverse.x.slice(0, dimension), 1e-12)
    || !same(y.slice(0, dimension), inverse.y.slice(0, dimension), 1e-12)) return null;
  const width = num(target.attributes[3]);
  if (width === null || width <= 0) return null;
  if (dimension === 2) {
    if (target.type.toUpperCase() !== 'IFCCARTESIANTRANSFORMATIONOPERATOR2DNONUNIFORM'
      || num(target.attributes[4]) !== 1) return null;
    const source = axis2d(reader, originId);
    if (!source || !same(source.o, sourceAnchor.slice(0, 2), 1e-9)
      || !same(source.x, inHost.x.slice(0, 2), 1e-12)) return null;
    return { repId: underlyingId, width, height: 1 };
  }
  const source = axis3d(reader, originId);
  const z = pointOf(reader, target.attributes[4], 'IFCDIRECTION');
  const height = num(target.attributes[6]);
  if (target.type.toUpperCase() !== 'IFCCARTESIANTRANSFORMATIONOPERATOR3DNONUNIFORM'
    || num(target.attributes[5]) !== 1 || height === null || height <= 0 || !source || !z
    || !same(source.o, sourceAnchor, 1e-9) || !same(source.x, inHost.x, 1e-12)
    || !same(source.y, inHost.y, 1e-12) || !same(source.z, inHost.z, 1e-12)
    || !same(z, inverse.z, 1e-12)) return null;
  return { repId: underlyingId, width, height };
}
