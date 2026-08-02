/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The pending-mutation overlay, in the shape `model_diff` needs to read it.
 *
 * A `model_id` on this server does not name a file — it names a session model,
 * and `entity_set_property` / `entity_set_attribute` / `entity_create` /
 * `entity_delete` queue their edits in a `MutablePropertyView` overlay that the
 * parsed `IfcDataStore` never sees (the store's buffer and index are immutable;
 * the overlay materialises at `export_ifc` / `model_save` time).
 *
 * Read straight from the store, a diff therefore answers about the file as it
 * was parsed. That is the wrong answer for the caller most likely to ask: an
 * agent that just edited a model and wants to know what it changed was told
 * "nothing" — renamed entities kept their old hashes, created ones were absent,
 * and deleted ones were still reported as present and unchanged.
 *
 * `model_diff` is the one tool where that is not survivable, because "what is
 * different" is the entire question, so it folds the overlay in on all three of
 * its passes and reports `pendingMutations` alongside the answer. The rest of
 * the read surface (`entity_get`, `entity_query`, …) still answers from the
 * parsed store; making it overlay-aware is a server-wide change and is not this
 * module's business.
 */

import type { PropertySet, QuantitySet } from '@ifc-lite/data';
import type { MutablePropertyView, NewEntity } from '@ifc-lite/mutations';
import type { LoadedModel } from '../context.js';

/** An entity that exists only in the overlay (`entity_create`). */
export interface CreatedEntity {
  expressId: number;
  /** IFC class as authored, e.g. `IfcWall`. */
  ifcType: string;
  globalId: string;
  name?: string;
  description?: string;
}

/** IfcRoot attribute overrides queued for an entity that is in the store. */
export interface AttributeOverrides {
  name?: string;
  description?: string;
  objectType?: string;
}

/** The overlay's read surface, as the diff passes consume it. */
export interface PendingOverlay {
  /** Express ids tombstoned by `entity_delete`. Empty is the common case. */
  readonly deleted: ReadonlySet<number>;
  /** Entities queued by `entity_create`, in creation order. */
  readonly created: readonly CreatedEntity[];
  /** Queued mutations on this model — the same number `mutation_diff` reports.
   *  Echoed back so a caller can tell a diff that includes uncommitted edits
   *  from one taken over two files as parsed. */
  readonly pendingMutations: number;
  attributes(expressId: number): AttributeOverrides;
  /** Base property sets with the overlay's edits applied. */
  propertySets(expressId: number): PropertySet[];
  /** Base quantity sets with the overlay's edits applied. */
  quantitySets(expressId: number): QuantitySet[];
}

/**
 * The model's pending overlay, or `null` when it has none.
 *
 * Null is the answer for every model that was only ever read: the backend
 * creates the view lazily on the first mutation, so an unedited session pays
 * nothing and every caller keeps its original store-only path.
 */
export function pendingOverlay(model: LoadedModel): PendingOverlay | null {
  const view = model.backend.getMutationView();
  if (!view || !view.hasPendingChanges()) return null;
  return new ViewOverlay(view);
}

class ViewOverlay implements PendingOverlay {
  readonly deleted: ReadonlySet<number>;
  readonly created: readonly CreatedEntity[];
  readonly pendingMutations: number;
  private readonly view: MutablePropertyView;

  constructor(view: MutablePropertyView) {
    this.view = view;
    this.deleted = view.getTombstones();
    this.created = view.getNewEntities().map(toCreatedEntity).filter((e): e is CreatedEntity => e !== null);
    this.pendingMutations = view.getMutations().length;
  }

  attributes(expressId: number): AttributeOverrides {
    const out: AttributeOverrides = {};
    for (const { name, value } of this.view.getAttributeMutationsForEntity(expressId)) {
      // `entity_set_attribute` also accepts `Tag`, which no fingerprint field
      // carries; the three below are the ones the data hash can see.
      if (name === 'Name') out.name = value;
      else if (name === 'Description') out.description = value;
      else if (name === 'ObjectType') out.objectType = value;
    }
    return out;
  }

  propertySets(expressId: number): PropertySet[] {
    return this.view.getForEntity(expressId);
  }

  quantitySets(expressId: number): QuantitySet[] {
    return this.view.getQuantitiesForEntity(expressId);
  }
}

/**
 * Read the IfcRoot header of an overlay-created entity.
 *
 * `NewEntity.attributes` is the positional STEP list the caller authored, so
 * slots 0/2/3 are `GlobalId`/`Name`/`Description` for every `IfcRoot` subtype
 * in every schema version — that part of the layout is fixed. Nothing further
 * along is: slot 4 is `ObjectType` on an `IfcObject` but `ApplicableOccurrence`
 * on an `IfcTypeObject`, so `objectType` and `PredefinedType` are read from the
 * store for store entities and simply absent for created ones.
 *
 * Returns null when slot 0 holds no GlobalId — a created `IfcCartesianPoint`
 * has no cross-model identity, and neither has a created root the caller left
 * unidentified.
 */
function toCreatedEntity(entity: NewEntity): CreatedEntity | null {
  const globalId = stepText(entity.attributes[0]);
  if (!globalId) return null;
  return {
    expressId: entity.expressId,
    ifcType: entity.type,
    globalId,
    name: stepText(entity.attributes[2]),
    description: stepText(entity.attributes[3]),
  };
}

/**
 * Unwrap one authored STEP attribute to plain text.
 *
 * `StoreEditor.addEntity` documents both `"'literal'"` and a bare string as
 * ways to write a string attribute, so the quotes have to come off before the
 * value is hashed — otherwise a created entity could never content-match the
 * same entity read back out of a file. `$` (unset), `*` (derived) and `#42`
 * (a reference) are not text.
 */
function stepText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed === '$' || trimmed === '*' || trimmed.startsWith('#')) return undefined;
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'") || undefined;
  }
  return trimmed;
}
