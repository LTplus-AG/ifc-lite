/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { IfcAttributeValue, IfcEntity } from '@ifc-lite/data';
import type { IfcDataStore } from './columnar-parser.js';
import { getAttributeNamesForSchema, normalizeIfcTypeName } from './ifc-schema.js';
import { getRelationshipSlotPlan } from './relationship-schema-slots.js';

export interface EffectiveRelationship {
  relationshipId: number;
  relationshipType: string;
  relating: readonly number[];
  related: readonly number[];
}

export interface RelationshipOverlayReader {
  createdEntities(): readonly IfcEntity[];
  mutatedEntityIds(): Iterable<number>;
  namedAttributes(expressId: number): Iterable<readonly [string, unknown]>;
  positionalAttributes(expressId: number): Iterable<readonly [number, IfcAttributeValue]>;
  isDeleted(expressId: number): boolean;
}

export interface EffectiveRelationshipOverlay {
  relationships: readonly EffectiveRelationship[];
  /** Parsed relationship rows whose base graph edges must be suppressed. */
  supersededSourceIds: ReadonlySet<number>;
}

function refIds(value: unknown): number[] {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? [value] : [];
  if (typeof value === 'string') {
    const match = /^#(\d+)$/.exec(value.trim());
    if (!match) return [];
    const id = Number(match[1]);
    return Number.isSafeInteger(id) ? [id] : [];
  }
  return Array.isArray(value) ? value.flatMap(refIds) : [];
}

function resolveRelationship(
  store: IfcDataStore,
  entity: IfcEntity,
  overlay: RelationshipOverlayReader,
): EffectiveRelationship | null {
  if (!entity.type.toUpperCase().startsWith('IFCREL') || overlay.isDeleted(entity.expressId)) return null;
  const names = getAttributeNamesForSchema(entity.type, store.schemaVersion);
  if (names.length === 0) return null;
  const attributes: unknown[] = [...entity.attributes];
  const named = new Map(overlay.namedAttributes(entity.expressId));
  const positional = new Map(overlay.positionalAttributes(entity.expressId));
  // Match both STEP export pipelines: named edits resolve first, then a
  // positional edit to the same slot wins. Querying a pending relationship
  // must describe the file that saving that pending overlay will produce.
  for (const [name] of named) {
    const index = names.indexOf(name);
    if (index >= 0) attributes[index] = named.get(name);
  }
  for (const [index, value] of positional) attributes[index] = value;

  const plan = getRelationshipSlotPlan(entity.type.toUpperCase(), store.schemaVersion);
  if (!plan) return null;
  const relating = refIds(attributes[4 + plan.relating.index]);
  const related = refIds(attributes[4 + plan.related.index]);
  if (!relating.length || !related.length) return null;
  return {
    relationshipId: entity.expressId,
    relationshipType: normalizeIfcTypeName(entity.type),
    relating,
    related,
  };
}

/** Resolve created and endpoint-mutated relationship records as one effective graph. */
export function resolveEffectiveRelationshipOverlay(
  store: IfcDataStore,
  overlay: RelationshipOverlayReader,
): EffectiveRelationshipOverlay {
  const relationships: EffectiveRelationship[] = [];
  const supersededSourceIds = new Set<number>();
  const createdIds = new Set<number>();
  for (const entity of overlay.createdEntities()) {
    createdIds.add(entity.expressId);
    const relation = resolveRelationship(store, entity, overlay);
    if (relation) relationships.push(relation);
  }
  for (const expressId of new Set(overlay.mutatedEntityIds())) {
    if (createdIds.has(expressId)) continue;
    const entity = store.getEntity(expressId);
    if (!entity?.type.toUpperCase().startsWith('IFCREL')) continue;
    supersededSourceIds.add(expressId);
    const relation = resolveRelationship(store, entity, overlay);
    if (relation) relationships.push(relation);
  }
  return { relationships, supersededSourceIds };
}

export function effectiveRelationshipEdges(
  overlay: EffectiveRelationshipOverlay,
  isDeleted: (expressId: number) => boolean,
  expressId: number,
  relationshipType?: string,
): Array<{ relationshipId: number; relationshipType: string; direction: 'forward' | 'inverse'; targetId: number }> {
  const upper = relationshipType?.toUpperCase();
  const out: Array<{ relationshipId: number; relationshipType: string; direction: 'forward' | 'inverse'; targetId: number }> = [];
  for (const relation of overlay.relationships) {
    if (upper && relation.relationshipType.toUpperCase() !== upper) continue;
    if (relation.relating.includes(expressId)) {
      for (const targetId of relation.related) if (!isDeleted(targetId)) out.push({
        relationshipId: relation.relationshipId,
        relationshipType: relation.relationshipType,
        direction: 'forward',
        targetId,
      });
    }
    if (relation.related.includes(expressId)) {
      for (const targetId of relation.relating) if (!isDeleted(targetId)) out.push({
        relationshipId: relation.relationshipId,
        relationshipType: relation.relationshipType,
        direction: 'inverse',
        targetId,
      });
    }
  }
  return out;
}
