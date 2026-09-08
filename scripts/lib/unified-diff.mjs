/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Classify a unified-diff line. Header prefixes inside hunks are content (#3634). */
export function unifiedDiffLineKind(line, insideHunk) {
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('\\')) return 'metadata';
  if (!insideHunk && (line.startsWith('---') || line.startsWith('+++'))) return 'header';
  if (line.startsWith('+')) return 'added';
  if (line.startsWith('-')) return 'removed';
  return 'context';
}
