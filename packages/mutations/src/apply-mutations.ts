/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The mutation-replay engine behind `MutablePropertyView.applyMutations` —
 * pulled out into its own module since the switch over `Mutation['type']`
 * is a large, self-contained dispatcher that only calls the view's already
 * PUBLIC methods (`setProperty`, `deleteProperty`, ...). The two spots that
 * touch the view's private state (`newEntities`, `deletedQsets`) are passed
 * in as narrow callbacks so this file never needs those fields exposed.
 */

import { QuantityType } from '@ifc-lite/data';
import type { PropertyValueType } from '@ifc-lite/data';
import type { IfcAttributeValue, PropertyValue, Mutation } from './types.js';

/**
 * The subset of `MutablePropertyView`'s public API `applyMutationsBatch`
 * dispatches into. Declared structurally (rather than importing the class)
 * so this module has no circular dependency on `mutable-property-view.ts`.
 */
export interface MutationApplyTarget {
  setProperty(
    entityId: number,
    psetName: string,
    propName: string,
    newValue: PropertyValue,
    valueType?: PropertyValueType,
  ): unknown;
  deleteProperty(entityId: number, psetName: string, propName: string): unknown;
  deletePropertySet(entityId: number, psetName: string): unknown;
  deleteQuantitySet(entityId: number, qsetName: string): unknown;
  setQuantity(
    entityId: number,
    qsetName: string,
    quantName: string,
    value: number,
    quantityType: QuantityType,
    unit?: string,
  ): unknown;
  createQuantitySet(
    entityId: number,
    qsetName: string,
    quantities: Array<{ name: string; value: number; quantityType: QuantityType; unit?: string }>,
  ): unknown;
  setPositionalAttribute(entityId: number, index: number, value: IfcAttributeValue): unknown;
  setEntityType(
    entityId: number,
    entityType: string,
    predefinedType: string | null,
    oldValue?: string,
  ): unknown;
  setAttribute(entityId: number, attributeName: string, newValue: string, oldValue?: string): unknown;
  createPropertySet(
    entityId: number,
    psetName: string,
    properties: Array<{ name: string; value: PropertyValue; type?: PropertyValueType; unit?: string }>,
  ): unknown;
  deleteEntity(expressId: number): unknown;
}

/**
 * Apply a batch of mutations (e.g., from imported change set) against
 * `target`. `hasNewEntity` and `markQuantitySetDeleted` give this function
 * the two bits of the view's private state the dispatcher needs without
 * exposing those fields publicly.
 */
export function applyMutationsBatch(
  target: MutationApplyTarget,
  mutations: Mutation[],
  hasNewEntity: (entityId: number) => boolean,
  markQuantitySetDeleted: (entityId: number, qsetName: string) => void,
): void {
  // CREATE_ENTITY records are skipped (callers must restore the
  // payload via restoreNewEntity). Track the ids we've skipped so a
  // matching DELETE_ENTITY in the same batch doesn't tombstone an
  // entity that never made it into this view — that stale tombstone
  // would later suppress a freshly-allocated overlay entity reusing
  // the same expressId.
  // Pass 1: collect every CREATE_ENTITY id up front, over the whole
  // array, before applying anything. CREATE_ENTITY is unconditionally
  // skipped below (every id it's called for lands here) — but a caller
  // supplying an arbitrary (e.g. imported/merged) Mutation[] may not have
  // its CREATE_ENTITY appear before the mutations that depend on it. A
  // single incremental forward pass would only "see" a create once the
  // loop reaches it, so a dependent mutation earlier in the array would
  // replay before its own entity's creation was known to be skipped —
  // reproducing the orphaned-pset bug via ordering instead of via the
  // original bug shape. Doing the full collection first makes the result
  // order-independent.
  const skippedCreateIds = new Set<number>();
  for (const mutation of mutations) {
    if (mutation.type === 'CREATE_ENTITY') {
      skippedCreateIds.add(mutation.entityId);
    }
  }

  // Pass 2: apply mutations against the now-complete skip set.
  for (const mutation of mutations) {
    // Any mutation recorded against an entity whose own CREATE_ENTITY was
    // skipped above would otherwise replay into an orphan — a pset (or
    // attribute/quantity/type edit) keyed to an expressId that exists in
    // neither the source buffer nor `newEntities`. Refuse those too, so
    // the round trip is lossy (entity + its edits both dropped) rather
    // than corrupting (edits surviving without their entity). This keys
    // off `skippedCreateIds`, not "id absent from newEntities", so a
    // mutation against a normal, pre-existing source-buffer entity is
    // never affected — only ids that had their own CREATE_ENTITY skipped
    // in this same batch land here.
    // The `newEntities` check makes the condition "the create was skipped
    // AND nothing else supplied the entity". A caller following the
    // documented recovery flow calls `restoreNewEntity()` first and
    // *then* replays the history; the id is live by the time we get here,
    // so there is no orphan to guard against and dropping its edits would
    // silently lose data on the exact path the console.warn recommends.
    if (
      mutation.type !== 'CREATE_ENTITY' &&
      skippedCreateIds.has(mutation.entityId) &&
      !hasNewEntity(mutation.entityId)
    ) {
      continue;
    }
    switch (mutation.type) {
      case 'CREATE_PROPERTY':
      case 'UPDATE_PROPERTY':
        if (mutation.psetName && mutation.propName && mutation.newValue !== undefined) {
          target.setProperty(
            mutation.entityId,
            mutation.psetName,
            mutation.propName,
            mutation.newValue,
            mutation.valueType
          );
        }
        break;

      case 'DELETE_PROPERTY':
        if (mutation.psetName && mutation.propName) {
          target.deleteProperty(mutation.entityId, mutation.psetName, mutation.propName);
        }
        break;

      case 'DELETE_PROPERTY_SET':
        if (mutation.psetName) {
          target.deletePropertySet(mutation.entityId, mutation.psetName);
        }
        break;

      case 'DELETE_QUANTITY_SET':
        if (mutation.psetName) {
          target.deleteQuantitySet(mutation.entityId, mutation.psetName);
          // The marker is recorded even when this view cannot SEE the base
          // set, unlike the live path. `deleteQuantitySet` only masks a set
          // the quantity extractor reports, and that extractor is opt-in
          // (null by default, and several in-tree callers wire the property
          // one beside it and not it). A replayed deletion is a decision the
          // origin session already made, so dropping it here would let a
          // later export regenerate a set the user removed. An inert marker
          // on a set that does not exist costs a row in the change list;
          // losing the deletion costs the user's edit.
          markQuantitySetDeleted(mutation.entityId, mutation.psetName);
        }
        break;

      case 'CREATE_QUANTITY':
      case 'UPDATE_QUANTITY':
        if (mutation.psetName && mutation.propName && mutation.newValue !== undefined) {
          target.setQuantity(
            mutation.entityId,
            mutation.psetName,
            mutation.propName,
            Number(mutation.newValue),
            (mutation.quantityType as QuantityType) ?? QuantityType.Count,
            mutation.unit,
          );
        } else if (
          mutation.type === 'CREATE_QUANTITY' &&
          mutation.psetName &&
          Array.isArray(mutation.newValue)
        ) {
          // `createQuantitySet()` (whole-qset creation, e.g.
          // `StoreEditor.addQuantitySet`) records ONE CREATE_QUANTITY mutation
          // for the whole set — no `propName`, `newValue` is the full
          // quantities array — unlike `setQuantity()`'s per-quantity
          // CREATE_QUANTITY, which always carries both. Mirrors the
          // CREATE_PROPERTY_SET handling below. Without this branch the
          // `psetName && propName` check above is false and the record
          // matched this `case` with nothing done — never falling through to
          // the "unhandled mutation type" warning either — so a freshly
          // created quantity set silently vanished on
          // exportMutations()/importMutations() round trip.
          target.createQuantitySet(
            mutation.entityId,
            mutation.psetName,
            mutation.newValue as unknown as Array<{ name: string; value: number; quantityType: QuantityType; unit?: string }>,
          );
        }
        break;

      case 'UPDATE_POSITIONAL_ATTRIBUTE': {
        // attributeName is `@<index>` for positional mutations.
        const attr = mutation.attributeName ?? '';
        if (!attr.startsWith('@')) break;
        const index = Number(attr.slice(1));
        if (!Number.isInteger(index) || index < 0) break;
        if (mutation.newValue === undefined) break;
        target.setPositionalAttribute(
          mutation.entityId,
          index,
          mutation.newValue as IfcAttributeValue,
        );
        break;
      }

      case 'UPDATE_ENTITY_TYPE': {
        const newType = mutation.entityType ?? (typeof mutation.newValue === 'string' ? mutation.newValue : undefined);
        if (!newType) break;
        target.setEntityType(
          mutation.entityId,
          newType,
          mutation.predefinedType ?? null,
          mutation.oldValue == null ? undefined : String(mutation.oldValue),
        );
        break;
      }

      case 'UPDATE_ATTRIBUTE':
        if (mutation.attributeName && mutation.newValue !== undefined && mutation.newValue !== null) {
          target.setAttribute(
            mutation.entityId,
            mutation.attributeName,
            String(mutation.newValue),
            mutation.oldValue == null ? undefined : String(mutation.oldValue),
          );
        }
        break;

      case 'CREATE_PROPERTY_SET':
        if (mutation.psetName && Array.isArray(mutation.newValue)) {
          // newValue is the original properties array (see createPropertySet,
          // where newValue = properties: Array<{ name; value; type?; unit? }>).
          target.createPropertySet(
            mutation.entityId,
            mutation.psetName,
            mutation.newValue as unknown as Array<{ name: string; value: PropertyValue; type?: PropertyValueType; unit?: string }>,
          );
        }
        break;

      case 'CREATE_ENTITY': {
        // Replay creates rely on the importer providing the entity body
        // via `restoreNewEntity` separately. The history record alone
        // doesn't carry the type+attributes payload — applying a bare
        // CREATE_ENTITY would lose the entity. We log and skip rather
        // than silently dropping it, so callers see they need to
        // restore the payload through the dedicated path. Unless the
        // caller already restored it, every other mutation recorded
        // against this id in this batch is dropped too (see the guard
        // above this switch) — otherwise the entity is gone but its edits
        // survive as an orphan. (skippedCreateIds was already fully
        // populated in pass 1, above.)
        // eslint-disable-next-line no-console
        console.warn(
          `applyMutations: CREATE_ENTITY for #${mutation.entityId} requires a NewEntity payload — ` +
            `restore via restoreNewEntity(). Skipping the record; dependent mutations recorded against ` +
            `#${mutation.entityId} are dropped too unless the entity was restored before this call.`,
        );
        break;
      }

      case 'DELETE_ENTITY':
        target.deleteEntity(mutation.entityId);
        break;

      default:
        // Surface unhandled mutation types instead of silently dropping
        // them, so future gaps in this switch are visible.
        // eslint-disable-next-line no-console
        console.warn(
          `applyMutations: unhandled mutation type '${mutation.type}' for #${mutation.entityId} — skipped`,
        );
        break;
    }
  }
}
