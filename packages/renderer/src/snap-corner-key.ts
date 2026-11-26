/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** What a screen-corner grid was built for (#11504); any difference means a new grid. */

import type { PickClipState } from './pick-types.js';

const setStamps = new WeakMap<object, number>();
let nextSetStamp = 1;
/**
 * A set's identity plus its size: hashing thousands of hidden ids on every
 * mouse move would cost more than the query. Hosts replace these sets when
 * visibility changes; an in-place edit that keeps the size is not seen.
 */
export function idsOf(s: ReadonlySet<number> | null | undefined): string {
  if (s == null) return '-';
  let id = setStamps.get(s);
  if (id === undefined) setStamps.set(s, id = nextSetStamp++);
  return `${id}:${s.size}`;
}

export function gridKey(viewKey: string, clip: PickClipState | null | undefined, w: number, h: number,
  hidden: ReadonlySet<number> | undefined, isolated: ReadonlySet<number> | null | undefined,
  cell: number, eligible: ReadonlySet<number> | undefined): string {
  const clipKey = clip ? JSON.stringify([clip.sectionPlane, clip.extraPlanes, clip.clipBox, idsOf(clip.sectionExcludedIds)]) : '';
  return [viewKey, clipKey, w, h, idsOf(hidden), idsOf(isolated), idsOf(eligible), cell].join('|');
}
