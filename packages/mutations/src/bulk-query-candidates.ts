/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `BulkQueryEngine`'s candidate set: the session's effective entities (#5249).
 *
 * The engine used to enumerate the base `EntityTable` directly. #5196 taught
 * it to skip tombstones, but two directions stayed wrong. An entity created
 * this session has no table row, so no bulk edit could ever select it. A
 * retyped entity was still selected by its PARSED class, because the type
 * filter read the row's `typeEnum`, so "set X on every IfcColumn" missed a
 * proxy the user had just reclassified as a column and hit a column the user
 * had reclassified away.
 *
 * Candidates now come from the shared effective-entity iterator, with the
 * table's rows as its source domain (the #5282 pattern). A row keeps its
 * `typeEnum` match exactly as before. A created or retyped entity matches by
 * its effective class. Its GlobalId and Name (for the globalIds / namePattern
 * filters) come from its authored payload, with a queued attribute edit
 * winning, as for every other overlay read in this package.
 */

import { IfcTypeEnum, type EntityTable } from '@ifc-lite/data';
import type { MutablePropertyView } from './mutable-property-view.js';
import { iterateEffectiveEntityIds } from './effective-entity-enumeration.js';
import { createdEntityStringAttribute } from './created-entity-attributes.js';

/** Placeholder class for a row whose enum has no name. It is never matched by name. */
const UNNAMED_ROW = 'IFC-LITE-UNNAMED-ROW';

export function effectiveBulkCandidates(
  entities: EntityTable,
  rows: ReadonlyMap<number, number>,
  view: MutablePropertyView,
  entityTypes?: readonly number[],
): number[] {
  const wantedEnums = entityTypes && entityTypes.length > 0 ? new Set(entityTypes) : null;
  const wantedNames = wantedEnums
    ? new Set(Array.from(wantedEnums, (e) => (IfcTypeEnum[e] ?? '').toUpperCase()).filter(Boolean))
    : null;
  const retypes = view.getTypeMutations();
  // The rows ARE the source domain. A row's class is its enum name, so the
  // iterator can apply a retype over it; the enum is what a row is matched on.
  const source = {
    entityIndex: {
      byType: new Map<string, readonly number[]>(),
      byId: {
        get: (id: number) => {
          const row = rows.get(id);
          if (row === undefined) return undefined;
          const name = IfcTypeEnum[entities.typeEnum[row]];
          return { type: name && name !== 'Unknown' ? name : UNNAMED_ROW };
        },
      },
    },
  };
  const ids: number[] = [];
  for (const { expressId, type, overlayCreated } of iterateEffectiveEntityIds(source, view, undefined, rows.keys())) {
    if (wantedEnums) {
      const matches = overlayCreated || retypes.has(expressId)
        ? wantedNames!.has(type)
        : wantedEnums.has(entities.typeEnum[rows.get(expressId)!]);
      if (!matches) continue;
    }
    ids.push(expressId);
  }
  return ids;
}

/**
 * The effective GlobalId or Name of a candidate: a created entity's authored
 * value, or a source row's column, with a queued attribute edit winning.
 */
export function effectiveRootAttribute(
  entities: EntityTable,
  strings: { get(idx: number): string },
  view: MutablePropertyView,
  row: number | undefined,
  expressId: number,
  attribute: 'GlobalId' | 'Name',
): string {
  const created = row === undefined ? view.getNewEntity(expressId) : null;
  if (created) return createdEntityStringAttribute(view, created, attribute);
  if (row === undefined) return '';
  for (const edit of view.getAttributeMutationsForEntity(expressId)) {
    if (edit.name === attribute) return edit.value;
  }
  return strings.get(attribute === 'GlobalId' ? entities.globalId[row] : entities.name[row]);
}
