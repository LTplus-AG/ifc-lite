/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Why a grid-bound element is not copied (#9026 item 8). A grid move carries the
 * element, and nothing can edit it free of the grid, so what a copy should bind
 * to is an open product decision, not something to guess here.
 */
import { copyDependentSteps } from './copy-dependent-walk.js';
import { hangsFromGrid } from './copy-frame.js';
import type { CopyContext } from './copy-product.js';
import { resolveDuplicateSource } from './resolve-source.js';
import { asRef } from './style-entity-reader.js';

const GRID_BOUND_REFUSAL = 'An element placed on a grid intersection stays tied to that grid, so it cannot be copied or arrayed. Place a new one on the other intersection instead';

/**
 * Whether `id` is refused for its grid binding, copied as part of `rootId`.
 * With no storey, or a storey with no placement, there is no frame to be tied
 * to: the model frame stands in, and such an element keeps copying as it always
 * has. A product pointing straight at the grid placement has no local placement to
 * copy at all, on any storey.
 */
function boundToGrid(ctx: CopyContext, id: number, rootId: number): boolean {
  const placementId = asRef(ctx.read(id)?.attributes[5]);
  if (!hangsFromGrid(ctx.read, placementId)) return false;
  if (placementId !== null && ctx.read(placementId)?.type.toUpperCase() === 'IFCGRIDPLACEMENT') return true;
  try {
    const { storeyId } = resolveDuplicateSource(ctx.store, rootId, ctx.editor);
    return storeyId !== null && asRef(ctx.read(storeyId)?.attributes[5]) !== null;
  } catch (error) {
    console.warn(`[create] #${rootId} has no readable placement to copy from`, error);
    return true;
  }
}

/** The refusal for `id` itself, or null. */
export function gridBoundRefusal(ctx: CopyContext, id: number): string | null {
  return boundToGrid(ctx, id, id) ? GRID_BOUND_REFUSAL : null;
}

/** {@link gridBoundRefusal} for what `rootId` carries with it: its parts, openings and fillings. */
export function carriedCopyRefusal(ctx: CopyContext, rootId: number): string | null {
  for (const step of copyDependentSteps(ctx, rootId)) {
    if (step.kind !== 'assembly' && boundToGrid(ctx, step.sourceId, rootId)) return GRID_BOUND_REFUSAL;
  }
  return null;
}
