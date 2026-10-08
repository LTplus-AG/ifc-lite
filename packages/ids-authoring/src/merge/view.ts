/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Framework-free view model for the conflict UI ("accept ours / theirs"
 * per conflict). A host renders `cards`, collects choices into
 * `resolutions` and calls `mergeDocuments` again with them.
 */

import type { SupportedLocale } from '@ifc-lite/ids';
import { describeChange } from '../diff/changelog.js';
import type { MergeConflict, MergeResult, MergeSide } from './types.js';

export interface ConflictCard {
  id: string;
  kind: MergeConflict['kind'];
  /** The specification the conflict is about, by name. */
  title: string;
  ours: string[];
  theirs: string[];
  resolution?: MergeSide;
}

export interface ConflictView {
  cards: ConflictCard[];
  unresolved: number;
  /** Order and gate notices, as sentences. */
  notices: string[];
  /** Resolutions as chosen so far (feed back into `mergeDocuments`). */
  resolutions: Record<string, MergeSide>;
}

function title(c: MergeConflict): string {
  for (const e of [...c.ours, ...c.theirs]) if ('specName' in e) return e.specName;
  return 'Document';
}

export function conflictView(result: MergeResult, locale: SupportedLocale = 'en'): ConflictView {
  const cards = result.conflicts.map((c) => ({
    id: c.id,
    kind: c.kind,
    title: title(c),
    ours: c.ours.map((e) => describeChange(e, locale)),
    theirs: c.theirs.map((e) => describeChange(e, locale)),
    ...(c.resolution ? { resolution: c.resolution } : {}),
  }));
  const resolutions: Record<string, MergeSide> = {};
  for (const c of result.conflicts) if (c.resolution) resolutions[c.id] = c.resolution;
  return {
    cards,
    unresolved: cards.filter((c) => !c.resolution).length,
    notices: result.diagnostics.map((d) => d.message),
    resolutions,
  };
}

/** Choose a side for one conflict; returns the next resolutions record. */
export function resolveConflict(resolutions: Readonly<Record<string, MergeSide>>, id: string, side: MergeSide): Record<string, MergeSide> {
  return { ...resolutions, [id]: side };
}
