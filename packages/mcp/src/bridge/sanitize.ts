/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The one way tab-supplied values enter a message that reaches the agent or
 * stderr (#9523). Browser-safe.
 *
 * Tab data is unbounded and untrusted: stringifying a value nested 30,000 deep
 * throws, a 12 MiB string inflates a tool error past every result limit, and a
 * newline forges a log line. So nothing from the tab is interpolated directly:
 * it goes through {@link clip}, which never recurses, caps the length and
 * replaces control characters.
 */

/** Longest clipped text, in characters, before the "(+N more)" suffix. */
export const CLIP_LENGTH = 200;

// C0/C1 controls, DEL, and the line/paragraph separators some log viewers honour.
// Matching control characters is this helper's purpose, not an accident.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

/**
 * A short, single-line description of `value`: strings and scalars are cut to
 * `max` characters with control characters replaced by `?`; objects and
 * arrays are named, never serialized.
 */
export function clip(value: unknown, max = CLIP_LENGTH): string {
  let text: string;
  if (typeof value === 'string') text = value;
  else if (typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) text = String(value);
  else if (Array.isArray(value)) return `an array`;
  else return `a ${typeof value}`;
  const extra = text.length - max;
  const cut = extra > 0 ? text.slice(0, max) : text;
  return cut.replace(CONTROL, '?') + (extra > 0 ? `…(+${extra} more)` : '');
}

/** {@link clip} in quotes, for naming a tab-supplied string inside a message. */
export function quoted(value: unknown, max = CLIP_LENGTH): string {
  return typeof value === 'string' ? `'${clip(value, max)}'` : clip(value, max);
}
