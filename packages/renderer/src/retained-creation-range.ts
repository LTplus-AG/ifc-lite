/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Reserve unused ownership before retained creations, without refusing a
 * source that loads beyond capacity. Both registration and hydration use this
 * check before changing ownership, so source IDs can never alias creations. */
export function retainedCreationEnd(sourceMax: number, sourceEnd: number, overlayEnd: number, firstRetained: number): number {
  if (!Number.isSafeInteger(firstRetained) || firstRetained < 0) {
    throw new Error(`[FederationRegistry] Invalid first retained ID: ${firstRetained}`);
  }
  if (firstRetained > 0 && firstRetained <= sourceMax) {
    throw new Error('[FederationRegistry] Source range already carries unpublished overlay IDs');
  }
  // A gap is useful only if its first creation can publish. Otherwise properties
  // still load, and the allocator's capacity check keeps editing blocked.
  return firstRetained > sourceEnd + 1 && firstRetained <= overlayEnd ? firstRetained - 1 : sourceEnd;
}
