/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Which elements an edit forces the mesher to rebuild (#6232 WP1).
 *
 * Openings and fillings are placed RELATIVE to their host, and an opening's
 * void is cut out of its host's mesh, so an element's mesh is not a function
 * of its own record alone:
 *
 *  - a changed OPENING re-cuts its host;
 *  - a host whose placement or body changed moves its openings and the
 *    fillings in them ('hostsChanged', and 'created', where the host is new);
 *  - a 'shape' edit (the element's own body, same placement) re-cuts nothing
 *    but itself and, for an opening, its host (its fillings are re-meshed
 *    too: the relationships found do not say which side is which, and one
 *    extra element costs less than a second lookup).
 *
 * The inverse relationships are the ones `remeshContextRoots` already finds,
 * including relationships the session created, so this reads them from there
 * rather than walking the graph a second way. Tombstoned ids are dropped.
 */

import type { IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import { remeshContextRoots } from '@ifc-lite/export';

export type RemeshCause = 'shape' | 'created' | 'hostsChanged';

/** The effective IFC class (UPPERCASE), retypes and overlay creations included. */
function typeOf(store: IfcDataStore, view: MutablePropertyView | null, id: number): string | undefined {
  const created = view?.getNewEntity(id);
  const type = view?.getEntityTypeMutation(id)?.newType ?? created?.type ?? store.entities.getTypeName(id);
  return type ? type.toUpperCase() : undefined;
}

function isLive(store: IfcDataStore, view: MutablePropertyView | null, id: number): boolean {
  if (view?.getTombstones().has(id)) return false;
  // @raw-entity-enumeration-ok point lookup of one id; tombstones and overlay creations are answered from the view on the lines around it
  return Boolean(view?.getNewEntity(id)) || store.entityIndex.byId.has(id);
}

/**
 * The live model-local express ids to re-mesh for an edit of `expressIds`.
 * Always includes the live targets themselves.
 */
export function expandAffectedSet(
  store: IfcDataStore,
  view: MutablePropertyView | null,
  expressIds: Iterable<number>,
  cause: RemeshCause,
): Set<number> {
  const targets = new Set<number>();
  for (const id of expressIds) if (isLive(store, view, id)) targets.add(id);
  if (targets.size === 0) return targets;

  const out = new Set(targets);
  const context = remeshContextRoots(store, view, targets);
  const openingTargets = [...targets].some((id) => typeOf(store, view, id) === 'IFCOPENINGELEMENT');
  for (const id of context) {
    const type = typeOf(store, view, id);
    if (!type || type === 'IFCPROJECT' || type.startsWith('IFCREL')) continue;
    if (cause !== 'shape') {
      out.add(id);
      continue;
    }
    // A reshaped opening re-cuts its host; nothing else moves.
    if (openingTargets && type !== 'IFCOPENINGELEMENT') out.add(id);
  }
  for (const id of out) if (!isLive(store, view, id)) out.delete(id);
  return out;
}
