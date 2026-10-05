/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** The Clash BCF archive export's settings (`useClash().exportBcf` / `bcfPreview`). */

import type { ClashSeverity } from '@ifc-lite/clash';

/** How clashes collapse into BCF topics. `storey` is omitted — Clash has no
 *  storey, so it degrades to `rule` (see grouping.ts) and would only confuse. */
export type ClashBcfGroupBy = 'cluster' | 'rule' | 'typePair' | 'element';

/** User-controllable settings for a BCF export — "what gets created". */
export interface ClashBcfConfig {
  /** Grouping dimension → one BCF topic per group. */
  groupBy: ClashBcfGroupBy;
  /** Only clashes of these severities become topics. */
  severities: ClashSeverity[];
  /** Render each topic's viewpoint offscreen and embed a PNG snapshot. */
  includeSnapshots: boolean;
  /** Safety cap on topic count; overflow is recorded in one marker topic. */
  maxTopics: number;
  /** Only these clashes, pinned when the export was opened (selected or filtered, #6925); all when absent. */
  clashIds?: ReadonlySet<string>;
}
