/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Where an attached top must end (#9296). A storey target keeps the top's
 * offset from it (Revit's Top Offset, kept implicitly): the top moves by what
 * the target storey moves relative to the element's own. A slab target puts
 * the top on the slab's underside, wherever the edit leaves it.
 *
 * Extension point for round 3 (pitched roofs): a roof target needs the
 * roof's underside over the element; add its reader beside
 * `slabUndersideWorld` and accept the class in `storey-attachment.ts`.
 */

import { getModelLengthUnitScale } from '../edit/length-unit-scale.js';
import { resolveSlabEditChain } from '../edit/slab-edit.js';
import type { EditTarget } from '../edit/target.js';
import { placementInAncestor, refId } from '../host-geometry-frame.js';
import { AnchorEntityReader } from '../resolve-anchor.js';
import { attachedTopWorldOrigin, type AttachedKind } from './storey-attached.js';
import type { TopAttachment } from './storey-attachment.js';

/** World Z of a flat slab's underside, metres, or null when it is not a flat extrusion of its outline. */
export function slabUndersideWorld(target: EditTarget, slabId: number): number | null {
  const scale = getModelLengthUnitScale(target.dataStore);
  const chain = resolveSlabEditChain(target.dataStore, target.view, target.editor, slabId, scale);
  if (!chain || chain.baseElevation === null) return null;
  const reader = new AnchorEntityReader(target.dataStore, target.view);
  const placementId = refId(reader.entity(slabId)?.attributes[5]);
  const frame = placementId === null ? null : placementInAncestor(reader, placementId, null);
  if (!frame) return null;
  // baseElevation is the solid's bottom in the placement's parent frame, measured from the same origin as placementOrigin.
  return frame.o[2] * scale + chain.baseElevation - chain.placementOrigin[2];
}

/**
 * The element's new `top` (`storey-attached.ts`) when its own storey moves by
 * `ownDelta` and its target's storey by `targetDelta` (metres); null when a
 * slab target or the element's base cannot be read.
 */
export function attachedTopTarget(
  target: EditTarget, elementId: number, kind: AttachedKind, attachment: TopAttachment, from: number, ownDelta: number, targetDelta: number,
): number | null {
  if (attachment.kind === 'storey') return from + targetDelta - ownDelta;
  const underside = attachment.targetElementId === undefined ? null : slabUndersideWorld(target, attachment.targetElementId);
  const origin = attachedTopWorldOrigin(target, elementId, kind);
  if (underside === null || origin === null || !Number.isFinite(origin)) return null;
  return underside + targetDelta - (origin + ownDelta);
}
