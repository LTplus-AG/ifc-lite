/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ObjectCountSummary } from './objectCountSummary';

/**
 * The lines of a count badge's hover card.
 *
 * The headline stands on its own — it is a count of physical objects that have
 * a shape, which is a complete answer without the hover. These lines explain
 * the mix and flag two things that are otherwise invisible, and each one is
 * emitted ONLY when it has something to say: a permanent "0 without geometry"
 * row is noise, and a line that appears is itself the signal. A row with no
 * summary (a class group, a model header) keeps the plain wording it had.
 */
export function countBadgeLines(elementCount: number, summary?: ObjectCountSummary): string[] {
  if (!summary) {
    return [`${elementCount.toLocaleString()} ${elementCount === 1 ? 'element' : 'elements'}`];
  }

  const lines = [`${summary.counted.toLocaleString()} ${summary.counted === 1 ? 'object' : 'objects'}`];
  if (summary.typeCounts.length > 0) {
    lines.push(summary.typeCounts.map(([type, n]) => `${n.toLocaleString()} ${type}`).join(' · '));
  }
  if (!summary.geometryKnown) {
    lines.push('geometry still loading — counting every object');
  }
  if (summary.withoutGeometry > 0) {
    const n = summary.withoutGeometry;
    lines.push(`${n.toLocaleString()} ${n === 1 ? 'element' : 'elements'} without geometry`);
  }
  if (summary.spacesNotCounted > 0) {
    const n = summary.spacesNotCounted;
    lines.push(`${n.toLocaleString()} ${n === 1 ? 'space' : 'spaces'} (not counted)`);
  }
  return lines;
}
