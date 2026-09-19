/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Overlay-visibility for `HeadlessBackend.query.related()` (headless-backend.ts).
 *
 * `bim.store.addEntity('default', { type: 'IfcRelContainedInSpatialStructure', ... })`
 * is how a CLI script places something — the record lives only in the session's
 * `MutablePropertyView` overlay until an export, exactly like `addEntity` for an
 * ordinary element (see `query-overlay.ts`). `related()` read `store.relationships`
 * alone, so a session that queued a containment relation and then asked
 * `bim.related(wall, 'IfcRelContainedInSpatialStructure', 'inverse')` to confirm
 * where its own wall landed got back nothing — the query answered about the file
 * as parsed, not as the session had just changed it.
 *
 * `@ifc-lite/mcp`'s parallel `HeadlessLikeBackend` already folds queued
 * relationships into `related()` for this exact reason (`packages/mcp/src/overlay.ts`,
 * #2014). This ports that half — reading relations back out of newly-created
 * `IfcRel…` entities — to the CLI, via `MutablePropertyView`'s own public
 * `getNewEntities()`/`isDeleted()`.
 */

import type { NewEntity } from '@ifc-lite/mutations';
import { getAttributeNamesAcrossSchemas } from '@ifc-lite/parser';

interface QueuedRelation {
  relationshipId: number;
  relationshipType: string;
  relating: number;
  related: readonly number[];
}

export interface QueuedRelationshipEdge {
  relationshipId: number;
  relationshipType: string;
  direction: 'forward' | 'inverse';
  targetId: number;
}

/** Express ids from an authored `'#42'` reference or a list of them. */
function refIds(value: unknown): number[] {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    const match = /^#(\d+)$/.exec(trimmed);
    if (!match) return [];
    const id = Number(match[1]);
    return Number.isSafeInteger(id) ? [id] : [];
  }
  if (Array.isArray(value)) return value.flatMap((item) => refIds(item));
  return [];
}

/**
 * Group queued `IfcRel…` creates by class, resolved to their two ends.
 *
 * By attribute name, never by slot — `IfcRelAggregates` puts `RelatingObject`
 * at slot 4, while `IfcRelContainedInSpatialStructure` puts `RelatedElements`
 * there. `getAttributeNamesAcrossSchemas` is cross-schema, so a queued IFC2X3
 * or IFC4X3 relationship resolves too, mirroring the MCP overlay this is
 * ported from.
 */
function indexQueuedRelations(created: readonly NewEntity[]): Map<string, QueuedRelation[]> {
  const byType = new Map<string, QueuedRelation[]>();
  for (const entity of created) {
    const upper = entity.type.toUpperCase();
    if (!upper.startsWith('IFCREL')) continue;
    const names = getAttributeNamesAcrossSchemas(entity.type);
    if (names.length === 0) continue;
    let relating: number | undefined;
    let related: number[] | undefined;
    for (let i = 0; i < names.length; i++) {
      if (names[i].startsWith('Related')) related ??= refIds(entity.attributes[i]);
      else if (names[i].startsWith('Relating')) relating ??= refIds(entity.attributes[i])[0];
    }
    if (relating === undefined || related === undefined || related.length === 0) continue;
    const relation: QueuedRelation = {
      relationshipId: entity.expressId,
      relationshipType: entity.type,
      relating,
      related,
    };
    const list = byType.get(upper);
    if (list) list.push(relation);
    else byType.set(upper, [relation]);
  }
  return byType;
}

/** Exact graph rows contributed by queued relationship records touching an entity. */
export function foldQueuedRelationshipEdges(
  newEntities: readonly NewEntity[],
  isDeleted: (expressId: number) => boolean,
  expressId: number,
): QueuedRelationshipEdge[] {
  const out: QueuedRelationshipEdge[] = [];
  for (const relations of indexQueuedRelations(newEntities).values()) {
    for (const relation of relations) {
      if (isDeleted(relation.relationshipId)) continue;
      if (relation.relating === expressId) {
        for (const targetId of relation.related) {
          if (!isDeleted(targetId)) out.push({
            relationshipId: relation.relationshipId,
            relationshipType: relation.relationshipType,
            direction: 'forward',
            targetId,
          });
        }
      }
      if (relation.related.includes(expressId) && !isDeleted(relation.relating)) {
        out.push({
          relationshipId: relation.relationshipId,
          relationshipType: relation.relationshipType,
          direction: 'inverse',
          targetId: relation.relating,
        });
      }
    }
  }
  return out;
}

/**
 * This session's queued `relType` relationships touching `expressId`, in the
 * given `direction` — the overlay half of `related()`. `newEntities` and
 * `isDeleted` come straight from `MutablePropertyView`, so a relationship
 * whose `IfcRel…` record was itself deleted this session (or whose far end
 * was) answers nothing, same as `related()`'s parsed-store half already does
 * for a queued edge that never got authored in the first place.
 */
export function foldQueuedRelated(
  newEntities: readonly NewEntity[],
  isDeleted: (expressId: number) => boolean,
  relType: string,
  direction: 'forward' | 'inverse',
  expressId: number,
): number[] {
  const byType = indexQueuedRelations(newEntities);
  const relations = byType.get(relType.toUpperCase()) ?? [];
  const out: number[] = [];
  for (const relation of relations) {
    if (isDeleted(relation.relationshipId)) continue;
    if (direction === 'forward') {
      if (relation.relating !== expressId) continue;
      for (const target of relation.related) {
        if (!isDeleted(target)) out.push(target);
      }
    } else {
      if (!relation.related.includes(expressId)) continue;
      if (!isDeleted(relation.relating)) out.push(relation.relating);
    }
  }
  return out;
}
