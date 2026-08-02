/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pure enumeration of `MutablePropertyView.getEffectiveChanges()` (issue
 * #1915), extracted out of `mutable-property-view.ts` to keep that file from
 * growing further past the ~400-line module-split guideline (AGENTS.md).
 *
 * `collectEffectiveChanges` takes a narrow, explicitly-typed snapshot of the
 * overlay maps/sets it needs plus a small set of resolver callbacks — never
 * the view instance itself — so it stays a pure function, independently
 * testable, and the view's private state stays private (the view passes a
 * `Readonly`-wrapped view of its own maps at call time).
 */

import type { PropertySet, QuantitySet } from '@ifc-lite/data';
import type {
  AttributeMutation,
  EffectiveChange,
  EntityTypeMutation,
  IfcAttributeValue,
  NewEntity,
  PropertyMutation,
  QuantityMutation,
} from './types.js';
import { propertyKey, quantityKey } from './types.js';

/** Base-value extractor for an entity attribute — see `MutablePropertyView.setAttributeExtractor`. */
export type AttributeExtractor = (entityId: number, attrName: string) => string | null;

/**
 * Narrow, read-only view of the overlay state `collectEffectiveChanges` reads.
 * Mirrors the corresponding private fields on `MutablePropertyView` exactly —
 * the view passes its own maps/sets directly (they satisfy these `Readonly*`
 * types structurally), so no copying is required per call.
 */
export interface EffectiveChangesSnapshot {
  attributeMutations: ReadonlyMap<string, AttributeMutation>;
  positionalAttrMutations: ReadonlyMap<number, ReadonlyMap<number, IfcAttributeValue>>;
  typeMutations: ReadonlyMap<number, EntityTypeMutation>;
  newPsets: ReadonlyMap<number, ReadonlyMap<string, PropertySet>>;
  deletedPsets: ReadonlySet<string>;
  newQsets: ReadonlyMap<number, ReadonlyMap<string, QuantitySet>>;
  deletedQsets: ReadonlySet<string>;
  propertyKeysByEntity: ReadonlyMap<number, ReadonlySet<string>>;
  propertyMutations: ReadonlyMap<string, PropertyMutation>;
  quantityKeysByEntity: ReadonlyMap<number, ReadonlySet<string>>;
  quantityMutations: ReadonlyMap<string, QuantityMutation>;
  newEntities: ReadonlyMap<number, NewEntity>;
  tombstones: ReadonlySet<number>;
}

/** Base-data resolvers `collectEffectiveChanges` needs for `previousValue`. */
export interface EffectiveChangesResolvers {
  /** Registered via `setAttributeExtractor`, or `null` if none was set. */
  attributeExtractor: AttributeExtractor | null;
  /** `MutablePropertyView.resolveBaseEntityId` — follows duplicate aliases. */
  resolveBaseEntityId: (entityId: number) => number;
  /** `MutablePropertyView`'s private `getBasePropertiesForEntity`. */
  getBasePropertiesForEntity: (entityId: number) => PropertySet[];
  /** `MutablePropertyView`'s private `getBaseQuantitiesForEntity`. */
  getBaseQuantitiesForEntity: (entityId: number) => QuantitySet[];
}

/** Stringify an overlay value for `EffectiveChange.previousValue` / `.newValue`. */
function stringifyEffectiveValue(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

/** Sort key for `getEffectiveChanges()`: entityId, then kind, then name, then setName. */
function compareEffectiveChanges(a: EffectiveChange, b: EffectiveChange): number {
  if (a.entityId !== b.entityId) return a.entityId - b.entityId;
  if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
  const an = a.name ?? '';
  const bn = b.name ?? '';
  if (an !== bn) return an < bn ? -1 : 1;
  const asn = a.setName ?? '';
  const bsn = b.setName ?? '';
  if (asn !== bsn) return asn < bsn ? -1 : 1;
  return 0;
}

/** Attribute + positional-attribute + retype overlay entries. */
function collectAttributeAndTypeChanges(
  snapshot: EffectiveChangesSnapshot,
  resolvers: EffectiveChangesResolvers,
  changes: EffectiveChange[],
): void {
  for (const [key, mutation] of snapshot.attributeMutations) {
    const entityId = Number(key.slice(0, key.indexOf(':')));
    const previousValue = resolvers.attributeExtractor
      ? stringifyEffectiveValue(
        resolvers.attributeExtractor(resolvers.resolveBaseEntityId(entityId), mutation.attribute),
      )
      : stringifyEffectiveValue(mutation.oldValue ?? null);
    changes.push({
      entityId,
      kind: 'attribute',
      name: mutation.attribute,
      previousValue,
      newValue: stringifyEffectiveValue(mutation.value),
    });
  }

  for (const [entityId, indexMap] of snapshot.positionalAttrMutations) {
    for (const [index, value] of indexMap) {
      changes.push({
        entityId,
        kind: 'attribute',
        name: `@${index}`,
        newValue: stringifyEffectiveValue(value),
      });
    }
  }

  for (const [entityId, mutation] of snapshot.typeMutations) {
    changes.push({
      entityId,
      kind: 'type',
      previousValue: mutation.oldType,
      newValue: mutation.newType,
    });
  }
}

/** Whole-pset / whole-qset add-or-delete overlay entries. */
function collectSetLevelChanges(snapshot: EffectiveChangesSnapshot, changes: EffectiveChange[]): void {
  for (const [entityId, entityPsets] of snapshot.newPsets) {
    for (const psetName of entityPsets.keys()) {
      changes.push({ entityId, kind: 'pset-added', setName: psetName });
    }
  }
  for (const key of snapshot.deletedPsets) {
    const entityId = Number(key.slice(0, key.indexOf(':')));
    const psetName = key.slice(key.indexOf(':') + 1);
    changes.push({ entityId, kind: 'pset-deleted', setName: psetName });
  }

  for (const [entityId, entityQsets] of snapshot.newQsets) {
    for (const qsetName of entityQsets.keys()) {
      changes.push({ entityId, kind: 'qset-added', setName: qsetName });
    }
  }
  for (const key of snapshot.deletedQsets) {
    const entityId = Number(key.slice(0, key.indexOf(':')));
    const qsetName = key.slice(key.indexOf(':') + 1);
    changes.push({ entityId, kind: 'qset-deleted', setName: qsetName });
  }
}

/**
 * Individual property mutations on EXISTING (base) psets. Mirrors
 * `MutablePropertyView.getForEntity()`'s own base-pset walk so prefix
 * stripping (not colon-splitting, which would break on a name containing
 * ':') recovers propName safely. Properties belonging to a newly-created or
 * wholly-deleted pset are reported by `collectSetLevelChanges` and skipped
 * here.
 */
function collectPropertyChanges(
  snapshot: EffectiveChangesSnapshot,
  resolvers: EffectiveChangesResolvers,
  changes: EffectiveChange[],
): void {
  for (const entityId of snapshot.propertyKeysByEntity.keys()) {
    const entityPropKeys = snapshot.propertyKeysByEntity.get(entityId)!;
    const basePsets = resolvers.getBasePropertiesForEntity(entityId);
    const visited = new Set<string>();

    for (const pset of basePsets) {
      if (snapshot.deletedPsets.has(`${entityId}:${pset.name}`)) continue;
      if (snapshot.newPsets.get(entityId)?.has(pset.name)) continue;

      for (const prop of pset.properties) {
        const key = propertyKey(entityId, pset.name, prop.name);
        if (!entityPropKeys.has(key)) continue;
        visited.add(key);
        const mutation = snapshot.propertyMutations.get(key)!;
        changes.push({
          entityId,
          kind: 'property',
          setName: pset.name,
          name: prop.name,
          previousValue: stringifyEffectiveValue(prop.value),
          newValue: mutation.operation === 'DELETE' ? undefined : stringifyEffectiveValue(mutation.value),
        });
      }

      const psetPrefix = `${entityId}:${pset.name}:`;
      for (const key of entityPropKeys) {
        if (visited.has(key) || !key.startsWith(psetPrefix)) continue;
        visited.add(key);
        const mutation = snapshot.propertyMutations.get(key);
        if (!mutation) continue;
        changes.push({
          entityId,
          kind: 'property',
          setName: pset.name,
          name: key.slice(psetPrefix.length),
          newValue: mutation.operation === 'DELETE' ? undefined : stringifyEffectiveValue(mutation.value),
        });
      }
    }
  }
}

/** Individual quantity mutations on EXISTING (base) qsets — mirrors `collectPropertyChanges`. */
function collectQuantityChanges(
  snapshot: EffectiveChangesSnapshot,
  resolvers: EffectiveChangesResolvers,
  changes: EffectiveChange[],
): void {
  for (const entityId of snapshot.quantityKeysByEntity.keys()) {
    const entityQtyKeys = snapshot.quantityKeysByEntity.get(entityId)!;
    const baseQsets = resolvers.getBaseQuantitiesForEntity(entityId);
    const visited = new Set<string>();

    for (const qset of baseQsets) {
      if (snapshot.deletedQsets.has(`${entityId}:${qset.name}`)) continue;
      if (snapshot.newQsets.get(entityId)?.has(qset.name)) continue;

      for (const q of qset.quantities) {
        const key = quantityKey(entityId, qset.name, q.name);
        if (!entityQtyKeys.has(key)) continue;
        visited.add(key);
        const mutation = snapshot.quantityMutations.get(key)!;
        changes.push({
          entityId,
          kind: 'quantity',
          setName: qset.name,
          name: q.name,
          previousValue: stringifyEffectiveValue(q.value),
          newValue: mutation.operation === 'DELETE' ? undefined : stringifyEffectiveValue(mutation.value),
        });
      }

      const qsetPrefix = `${entityId}:${qset.name}:`;
      for (const key of entityQtyKeys) {
        if (visited.has(key) || !key.startsWith(qsetPrefix)) continue;
        visited.add(key);
        const mutation = snapshot.quantityMutations.get(key);
        if (!mutation) continue;
        changes.push({
          entityId,
          kind: 'quantity',
          setName: qset.name,
          name: key.slice(qsetPrefix.length),
          newValue: mutation.operation === 'DELETE' ? undefined : stringifyEffectiveValue(mutation.value),
        });
      }
    }
  }
}

/** Entity create / delete overlay entries. */
function collectEntityChanges(snapshot: EffectiveChangesSnapshot, changes: EffectiveChange[]): void {
  for (const [entityId, entity] of snapshot.newEntities) {
    changes.push({ entityId, kind: 'entity-added', newValue: entity.type });
  }
  for (const entityId of snapshot.tombstones) {
    changes.push({ entityId, kind: 'entity-deleted' });
  }
}

/**
 * Enumerate every change the overlay currently carries, as it stands right
 * now — never from `mutationHistory`. Backs
 * `MutablePropertyView.getEffectiveChanges()`: `previousValue` is derived
 * from the base data (property table / on-demand extractor / attribute
 * extractor), so an undo→redo cycle reports the true original, not a stale
 * history entry.
 *
 * Whole-pset/qset deletes and creates are reported as a single
 * `pset-added` / `pset-deleted` / `qset-added` / `qset-deleted` row rather
 * than one row per property/quantity inside them (`deletePropertySet` /
 * `createPropertySet` also populate individual property/quantity mutations
 * internally — those are intentionally not double-reported here).
 *
 * Deterministic ordering: entityId, then kind, then name, then setName.
 */
export function collectEffectiveChanges(
  snapshot: EffectiveChangesSnapshot,
  resolvers: EffectiveChangesResolvers,
): EffectiveChange[] {
  const changes: EffectiveChange[] = [];

  collectAttributeAndTypeChanges(snapshot, resolvers, changes);
  collectSetLevelChanges(snapshot, changes);
  collectPropertyChanges(snapshot, resolvers, changes);
  collectQuantityChanges(snapshot, resolvers, changes);
  collectEntityChanges(snapshot, changes);

  changes.sort(compareEffectiveChanges);
  return changes;
}
