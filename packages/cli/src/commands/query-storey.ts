/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `query --storey` resolution — extracted from `query.ts` (module-size
 * ratchet) but otherwise unchanged behavior.
 *
 * IfcBuildingStorey.Name is not unique: two storeys legally share a Name as
 * siblings under different buildings, or a malformed/federated file can
 * duplicate a level name outright. Matching by GlobalId/expressId is
 * unambiguous; matching by Name is not, so every storey with that Name is
 * included rather than picking an arbitrary first match and silently
 * dropping the rest (a same-named-storey element would otherwise vanish
 * from the result depending on array order).
 */

import { fatal } from '../output.js';

/**
 * Resolve `--storey <filter>` to the set of expressIds of every entity
 * directly contained in the matching storey/storeys.
 *
 * Resolution order:
 *  1. An exact expressId match (unambiguous — expressIds are unique) wins
 *     outright and resolves to that single storey.
 *  2. Otherwise, every storey with an exact Name match.
 *  3. Otherwise, every storey whose Name contains the filter (case-insensitive).
 *
 * Exits via `fatal()` (never returns) if no storey matches at all.
 */
export function resolveStoreyIds(bim: any, storeyFilter: string): Set<number> {
  const storeys = bim.storeys();
  const byExpressId = storeys.find((s: any) => String(s.ref.expressId) === storeyFilter);
  let matchedStoreys: any[];
  if (byExpressId) {
    matchedStoreys = [byExpressId];
  } else {
    const exactNameMatches = storeys.filter((s: any) => s.name === storeyFilter);
    matchedStoreys = exactNameMatches.length > 0
      ? exactNameMatches
      : storeys.filter((s: any) => s.name.toLowerCase().includes(storeyFilter.toLowerCase()));
  }
  if (matchedStoreys.length === 0) {
    const names = storeys.map((s: any) => s.name).filter(Boolean).join(', ');
    fatal(`Storey "${storeyFilter}" not found. Available: ${names || '(none)'}`);
  }
  const storeyIds = new Set<number>();
  for (const storey of matchedStoreys) {
    for (const e of bim.contains(storey.ref)) storeyIds.add(e.ref.expressId);
  }
  return storeyIds;
}
