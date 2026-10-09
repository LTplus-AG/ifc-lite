/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Node bookkeeping shared by the sandbox, the tools and the proposal. */

import type { Diagnostic, StudioDocument, Uuid } from '@ifc-lite/ids-authoring';

/**
 * A stable id for a diagnostic: rule code, node and field. Diagnostics carry
 * no id of their own; this one survives re-linting, so the model can name a
 * finding in `ids_apply_fix` after other edits.
 */
export function diagnosticId(d: Pick<Diagnostic, 'code' | 'nodeId' | 'field'>): string {
  return `${d.code}@${d.nodeId}${d.field ? `/${d.field}` : ''}`;
}

/** Node id → owning specification id, for every node of `doc`. */
export function specOwners(doc: StudioDocument): Map<Uuid, Uuid> {
  const owners = new Map<Uuid, Uuid>();
  for (const spec of doc.nodes.specs) {
    owners.set(spec.id, spec.id);
    for (const facet of [...spec.applicability, ...spec.requirements]) {
      owners.set(facet.id, spec.id);
      for (const id of Object.values(facet.constraints)) if (id) owners.set(id, spec.id);
    }
  }
  return owners;
}

/** The specifications a set of touched nodes belongs to, before or after the change. */
export function specIdsFor(touched: Iterable<Uuid>, before: StudioDocument, after: StudioDocument): Uuid[] {
  const ownersAfter = specOwners(after);
  const ownersBefore = specOwners(before);
  const specs = new Set<Uuid>();
  for (const id of touched) {
    const owner = ownersAfter.get(id) ?? ownersBefore.get(id);
    if (owner) specs.add(owner);
  }
  return [...specs];
}
