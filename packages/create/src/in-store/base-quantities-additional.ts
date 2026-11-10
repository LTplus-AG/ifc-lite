/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { QuantityType } from '@ifc-lite/data';
import type { EditTarget } from './edit/target.js';
import { asExpressIdRef, readAttributes } from './edit/placement-core.js';
import { getModelLengthUnitScale } from './edit/length-unit-scale.js';
import { readStairDimensions } from './stair-edit.js';
import { stairFlightOutline } from './stair.js';
import { polygonArea, sectionMeasures } from './base-quantities-measure.js';
import { readCurtainWallParts } from './curtain-wall-relayout.js';
import { sectionFromProfile } from './edit/read-profile.js';
import { profileSectionExtent } from './profile.js';

type Row = readonly [string, QuantityType.Length | QuantityType.Area | QuantityType.Volume, number];
/** SI measures from the canonical occurrence readers, without bounding-box volumes. */
export function additionalQuantityRows(target: EditTarget, id: number, type: string): Row[] | null {
  const { dataStore: store, view, editor } = target, scale = getModelLengthUnitScale(store);
  if (['IFCDOOR', 'IFCDOORSTANDARDCASE', 'IFCWINDOW', 'IFCWINDOWSTANDARDCASE'].includes(type)) {
    const attrs = readAttributes(store, view, editor, id), h = attrs?.[8], w = attrs?.[9];
    if (typeof w !== 'number' || typeof h !== 'number' || !Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
    return [['Width', QuantityType.Length, w * scale], ['Height', QuantityType.Length, h * scale], ['Area', QuantityType.Area, w * h * scale ** 2]];
  }
  if (type === 'IFCSTAIR') {
    const d = readStairDimensions(store, id, view);
    if (!d) return null;
    const volume = polygonArea(stairFlightOutline(d.NumberOfRisers, d.RiserHeight, d.TreadLength, d.WaistThickness)) * d.Width;
    return [['Length', QuantityType.Length, d.NumberOfRisers * d.TreadLength], ['GrossVolume', QuantityType.Volume, volume], ['NetVolume', QuantityType.Volume, volume]];
  }
  if (type !== 'IFCCURTAINWALL') return null;
  const wall = readCurtainWallParts(target, id);
  if (!wall) return null;
  let volume = 0, min = Infinity, max = -Infinity;
  for (const part of wall.parts) {
    const solid = readAttributes(store, view, editor, part.solidId), profileId = asExpressIdRef(solid?.[0]);
    const attrs = profileId === null ? null : readAttributes(store, view, editor, profileId);
    const profileType = profileId === null ? null : editor.getEntityType(profileId);
    const section = attrs && profileType ? sectionFromProfile(profileType, attrs, scale, store.schemaVersion ?? 'IFC4') : null;
    if (!section) return null;
    const [w, h] = profileSectionExtent(section), measures = sectionMeasures(section, w, h);
    if (!measures) return null;
    volume += measures.area * part.depth;
    // Panel profile X spans the clear bay from the placement's U.
    if (part.role === 'panel') { min = Math.min(min, part.u); max = Math.max(max, part.u + w); }
    if (part.role === 'mullion') { min = Math.min(min, part.u - w / 2); max = Math.max(max, part.u + w / 2); }
  }
  if (!Number.isFinite(max - min) || max <= min) return null;
  return [['Height', QuantityType.Length, wall.height], ['GrossSideArea', QuantityType.Area, (max - min) * wall.height],
    ['GrossVolume', QuantityType.Volume, volume], ['NetVolume', QuantityType.Volume, volume]];
}
