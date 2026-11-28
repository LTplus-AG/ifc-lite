/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** What a screen-corner grid was built for (#11504); any difference means a new grid. */

import type { PickClipState } from './pick-types.js';

// Cache the canonical membership key while checking for in-place edits on every use.
const setKeys = new WeakMap<ReadonlySet<number>, { members: number[]; key: string }>();

export function idsOf(s: ReadonlySet<number> | null | undefined): string {
  if (s == null) return '-';
  if (s.size === 0) return '';
  const cached = setKeys.get(s);
  if (cached && cached.members.length === s.size && cached.members.every(id => s.has(id))) return cached.key;
  const members = [...s].sort((a, b) => a - b);
  const key = members.join(',');
  setKeys.set(s, { members, key });
  return key;
}

/** Model eligibility is a small, mutable set. Snapshot its members for both grid caches. */
export function eligibleModelsKey(models: ReadonlySet<number> | undefined): string {
  return models === undefined ? '*' : Array.from(models).sort((a, b) => a - b).join(',');
}

export function gridKey(viewKey: string, clip: PickClipState | null | undefined, w: number, h: number,
  hidden: ReadonlySet<number> | undefined, isolated: ReadonlySet<number> | null | undefined,
  cell: number, eligible: ReadonlySet<number> | undefined): string {
  const clipKey = clip ? JSON.stringify([clip.sectionPlane, clip.extraPlanes, clip.clipBox, idsOf(clip.sectionExcludedIds)]) : '';
  return [viewKey, clipKey, w, h, idsOf(hidden), idsOf(isolated), eligibleModelsKey(eligible), cell].join('|');
}
