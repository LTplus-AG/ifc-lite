/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Identity policy for a split element (#6233, charter #6232 "Decisions").
 *
 * - The LARGER piece keeps the source entity: express id, GlobalId,
 *   containment, type, material, property sets. Larger is length for walls /
 *   beams / members / columns and footprint area for slabs / roofs / plates /
 *   spaces; a tie goes to the piece containing the axis / profile start
 *   ({@link keepsFirstPiece}).
 * - The NEW piece's GlobalId is a name-based UUID (v5) of
 *   `${sourceGlobalId}/split/${k}` in {@link SPLIT_GLOBALID_NAMESPACE},
 *   encoded as the 22-character IFC GlobalId. `k` starts at 0 and increments
 *   while the candidate already exists ({@link deriveSplitGlobalId}). It does
 *   not depend on where the cut is, so the same source in the same model
 *   always yields the same id: a split replayed on another machine, or
 *   re-done after an undo, reproduces it.
 */

import { uuidToIfcGuid, uuidV5 } from '@ifc-lite/encoding';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';

/** ifc-lite's fixed namespace for split-piece GlobalIds. Never change it:
 *  every derived id in every saved model depends on it. */
export const SPLIT_GLOBALID_NAMESPACE = '5e904553-f79a-466a-8ec3-53d331437713';

/**
 * The GlobalId for the next piece split off `sourceGlobalId`: the first
 * `k = 0, 1, …` whose candidate `isTaken` rejects. Pure: the same source and
 * the same set of existing ids give the same result.
 */
export function deriveSplitGlobalId(sourceGlobalId: string, isTaken: (globalId: string) => boolean): string {
  for (let k = 0; ; k++) {
    const candidate = uuidToIfcGuid(uuidV5(SPLIT_GLOBALID_NAMESPACE, `${sourceGlobalId}/split/${k}`));
    if (!isTaken(candidate)) return candidate;
  }
}

/**
 * Whether the FIRST piece (the one containing the axis / profile start) keeps
 * the source identity: it is at least as large as the second. Sizes are
 * lengths or areas.
 */
export function keepsFirstPiece(firstSize: number, secondSize: number): boolean {
  return firstSize >= secondSize;
}

/** What {@link globalIdTakenIn} needs of one loaded model. */
export interface GlobalIdScope {
  dataStore: Pick<IfcDataStore, 'entities'> | null | undefined;
  view: Pick<MutablePropertyView, 'getNewEntities'> | null | undefined;
}

/**
 * "Does any loaded model already carry this GlobalId?" over the parsed index
 * AND the entities authored this session, across every federated model — a
 * split piece must not collide with an element of another model either.
 */
export function globalIdTakenIn(scopes: Iterable<GlobalIdScope>): (globalId: string) => boolean {
  const authored = new Set<string>();
  const stores: Array<Pick<IfcDataStore, 'entities'>> = [];
  for (const { dataStore, view } of scopes) {
    if (dataStore) stores.push(dataStore);
    for (const entity of view?.getNewEntities() ?? []) {
      const guid = entity.attributes[0];
      if (typeof guid === 'string') authored.add(guid);
    }
  }
  return (globalId) => authored.has(globalId)
    || stores.some((store) => (store.entities.getExpressIdByGlobalId?.(globalId) ?? -1) > 0);
}
