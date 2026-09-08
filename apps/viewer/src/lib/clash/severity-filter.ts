/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Drop clashes whose severity is not selected, rebuilding the WHOLE summary
 * (not just `total`): this feeds `exportBcf`/`bcfPreview` in `useClash`, and a
 * stale `byTypePair`/`byRule`/`bySeverity` would still advertise buckets the
 * filter just removed.
 */

import { summarizeClashes, type ClashResult, type ClashSeverity } from '@ifc-lite/clash';

export function filterResultBySeverity(result: ClashResult, severities: Set<ClashSeverity>): ClashResult {
  const clashes = result.clashes.filter((c) => severities.has(c.severity));
  return { ...result, clashes, summary: summarizeClashes(clashes) };
}
