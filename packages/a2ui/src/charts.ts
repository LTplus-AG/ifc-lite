/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Chart and colour rules shared by every IFC renderer, so they draw the same thing. */

export const DEFAULT_MAX_GROUPS = 12;
const MAX_GROUPS_CEILING = 100;

/** A GroupChart's `maxGroups`: below 2 (or not a number) means the default, so Other always has a group beside it. */
export function resolveMaxGroups(raw: unknown): number {
  const floored = typeof raw === 'number' ? Math.floor(raw) : NaN;
  return floored > 1 ? Math.min(MAX_GROUPS_CEILING, floored) : DEFAULT_MAX_GROUPS;
}

/** Keep the `max - 1` largest groups by magnitude, in their given order, and fold the rest into `other(rest)`. */
export function foldGroups<G extends { value: number }>(groups: readonly G[], max: number, other: (rest: G[]) => G): G[] {
  if (groups.length <= max) return [...groups];
  const largest = new Set([...groups].sort((a, b) => Math.abs(b.value) - Math.abs(a.value)).slice(0, max - 1));
  const head: G[] = [];
  const rest: G[] = [];
  for (const g of groups) (largest.has(g) ? head : rest).push(g);
  return [...head, other(rest)];
}

// #rgb and #rrggbb only: the forms every colour parser downstream (viewer hexToRgba, MCP viewer_colorize) reads.
const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** A hex colour from untrusted surface data, or `fallback` for anything else (never arbitrary CSS). */
export function safeHexColor(value: unknown, fallback: string): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return HEX_COLOR.test(trimmed) ? trimmed : fallback;
}
