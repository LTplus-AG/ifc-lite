/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Collected in the parser's existing byte-reader pass, in its worker.
 * Aggregate coverage preserves the historical model-wide refusal contract;
 * unverified rows alone require the canonical source reader. Clone-safe. */
export type SelectionRelationshipIndex = NonNullable<import('@ifc-lite/data').IfcStoreBase['selectionRelationshipIndex']>;
export function newSelectionRelationshipIndex(): SelectionRelationshipIndex {
  return { missing: [], typeRows: 0, typeReferences: 0, unverifiedTypeRows: [], typeDefinitions: new Map(), typeExceptionalReferences: new Map(), typeRefusals: new Map(),
    exceptionalSubjects: new Map(), exceptionalDefinitionTargets: new Map(), retryTypeRows: [] };
}
export function indexTypeRelationship(index: SelectionRelationshipIndex, id: number, members: readonly number[] | undefined,
  targets: readonly number[] | undefined, verified = true): void {
  index.typeRows++;
  if (!members?.length || !targets?.length || !verified) {
    index.unverifiedTypeRows.push(id);
    if (!members || !targets) index.missing.push(id);
  } else index.typeReferences += (members.length < 2 ? members.length : new Set(members).size) * (targets.length < 2 ? targets.length : new Set(targets).size);
}
