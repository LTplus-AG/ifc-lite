/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// WebGPU picking uses r32uint. Keep global IDs well inside that limit.
export const MAX_SAFE_OFFSET = 2_000_000_000;
export const OVERLAY_ID_HEADROOM = 1_000_000;

/** Validation refused before any registry ownership changed. */
export class ModelRangeExtensionRefusedError extends Error {}

/** Reserve unused ownership before retained creations, without refusing a
 * source that loads beyond capacity. Registration passes no overlapping ID;
 * hydration refuses overlap here before changing ownership, so source IDs can
 * never alias creations. */
export function retainedCreationEnd(sourceMax: number, sourceEnd: number, overlayEnd: number, firstRetained: number): number {
  if (!Number.isSafeInteger(firstRetained) || firstRetained < 0) {
    throw new ModelRangeExtensionRefusedError(`[FederationRegistry] Invalid first retained ID: ${firstRetained}`);
  }
  if (firstRetained > 0 && firstRetained <= sourceMax) {
    throw new ModelRangeExtensionRefusedError('[FederationRegistry] Source range already carries unpublished overlay IDs');
  }
  // A gap is useful only if its first creation can publish. Otherwise properties
  // still load, and the allocator's capacity check keeps editing blocked.
  return firstRetained > sourceEnd + 1 && firstRetained <= overlayEnd ? firstRetained - 1 : sourceEnd;
}

/** Compute bounds for a fresh registration before a neighbor fixes its upper limit. */
export function reserveRetainedRange(offset: number, sourceMax: number, firstRetained: number, nextRetained: number) {
  if (offset + sourceMax > MAX_SAFE_OFFSET) {
    throw new Error(
      `[FederationRegistry] Cannot register model: would exceed safe ID limit. ` +
      `Current offset: ${offset}, reserved model max ID: ${sourceMax}. Please unload some models first.`,
    );
  }
  if (!Number.isSafeInteger(nextRetained) || nextRetained < 0) {
    throw new ModelRangeExtensionRefusedError(`[FederationRegistry] Invalid next retained ID: ${nextRetained}`);
  }
  const safeLocalEnd = MAX_SAFE_OFFSET - offset;
  // A source edit can carry the old source watermark. Preserve its allocator without
  // increasing the normal limit for retained creations, which have their own claims.
  const retainedEnd = firstRetained === 0 && nextRetained <= safeLocalEnd ? nextRetained - 1 : 0;
  const overlayMaxExpressId = Math.max(sourceMax, retainedEnd) + OVERLAY_ID_HEADROOM;
  const firstOverlay = firstRetained || (nextRetained > sourceMax ? nextRetained : 0);
  const ownedEnd = retainedCreationEnd(sourceMax, sourceMax, Math.min(overlayMaxExpressId, safeLocalEnd), firstOverlay);
  return { ownedEnd, overlayMaxExpressId };
}
