/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

const identities = new WeakMap<object, number>();
let nextIdentity = 0;

/**
 * A stable number per object (0 for none), for cache keys over inputs that
 * change by replacement rather than by a version counter. Weak keys, so a
 * replaced object is never kept alive by its number.
 */
export function objectIdentity(value: object | null | undefined): number {
  if (!value) return 0;
  let id = identities.get(value);
  if (id === undefined) identities.set(value, id = ++nextIdentity);
  return id;
}
