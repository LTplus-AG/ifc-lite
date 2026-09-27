/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Store glue for the semantic source: the wall axes of one storey, in
 * storey-local metres (the storey workplane's local frame).
 *
 * `extractWallSegmentsForStorey` is the canonical reader (axis representation
 * or rectangle profile, composed into the storey frame, unit-scaled, overlay-
 * created walls read live). It reads SOURCE walls from the source bytes, so a
 * source wall moved this session (resizeWall / endpoint drag write its edit
 * chain) would snap to where it used to be. For those walls the live axis
 * comes from `resolveWallEditChain`, in the storey-local frame the edit path
 * itself writes.
 */

import type { IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { extractWallSegmentsForStorey } from '@ifc-lite/create';
import { resolveWallEditChain } from '@/lib/wall-edit';
import type { WallAxis } from './semantic.js';

export function storeyWallAxes(
  store: IfcDataStore,
  view: MutablePropertyView,
  editor: StoreEditor,
  storeyId: number,
): WallAxis[] {
  const res = extractWallSegmentsForStorey(store, storeyId, view);
  const created = new Set(view.getNewEntities().map((e) => e.expressId));
  const axes: WallAxis[] = [];
  res.segments.forEach((seg, i) => {
    const expressId = res.contributingWallIds[i];
    const live = created.has(expressId) ? null : movedAxis(store, view, editor, expressId, res.lengthUnitScale);
    axes.push(live ?? { expressId, a: seg.a, b: seg.b });
  });
  return axes;
}

/**
 * The live axis of a source wall whose edit chain carries pending edits, else
 * null. The chain holds native STEP units; `unitScale` (raw → metres, as the
 * extractor applies to source walls) brings the axis into the same frame.
 */
function movedAxis(
  store: IfcDataStore,
  view: MutablePropertyView,
  editor: StoreEditor,
  expressId: number,
  unitScale: number,
): WallAxis | null {
  const chain = resolveWallEditChain(store, view, editor, expressId);
  if (!chain) return null;
  const edited = [chain.startPointId, chain.refDirectionId, chain.profileId]
    .some((id) => (view.getPositionalMutationsForEntity(id)?.size ?? 0) > 0);
  if (!edited) return null;
  const [sx, sy] = chain.startCoordinates;
  const [dx, dy] = chain.refDirection;
  const len = Math.hypot(dx, dy);
  if (!(len > 0)) return null;
  const k = chain.wallLength / len;
  const m = unitScale;
  return { expressId, a: [sx * m, sy * m], b: [(sx + dx * k) * m, (sy + dy * k) * m] };
}
