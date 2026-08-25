/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The per-phase contexts that do NOT allocate express ids.
 *
 * Split out of `StepExporter` for #2475. These two are pure forwarders: they
 * assemble what a phase cannot read off the pass, out of values handed to
 * them, and touch no exporter state of their own.
 *
 * WHY ONLY THESE TWO. `georefContext` and `propertySetContext` stay methods on
 * `StepExporter`, and `collectionContext` stays with them because it forwards
 * to both. Those two are the only places that mint express ids, via
 * `allocateExpressId: () => this.nextExpressId++` — two closures over ONE
 * instance counter. Moving them would mean re-establishing that shared
 * identity through a parameter, and capturing the counter's value instead of
 * its closure gives each builder its own sequence, silently emitting two
 * entities with the same `#N` — well-formed STEP in which every reference
 * still resolves, and two different entities.
 *
 * That failure used to be invisible: `findDanglingRefs` collects defined ids
 * into a `Set`, which absorbs a duplicate rather than reporting it. It is now
 * caught — `step-georeferencing.test.ts`'s "mints distinct ids for generated
 * psets and for created georeferencing" drives both allocating paths in one
 * export and asserts no id is defined twice. Freezing both closures fails that
 * test and only that test.
 *
 * So the reason this module holds two functions rather than five is written
 * down here AND checkable, which is the only reason it is safe to leave the
 * other three where they are.
 */

import type { IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import { applySourceLineMutations } from './step-attribute-mutations.js';
import { applyOverlayEntityOverrides } from './step-overlay-attribute-overrides.js';
import { relationshipWithheldWarning } from './step-export-types.js';
import { isGeometryEntity } from './step-geometry-types.js';
import type { SourceIterationContext } from './step-source-iteration.js';
import type { OverlayEntitiesContext } from './step-overlay-entities.js';
import type { PropertySetContext } from './step-property-set-readers.js';

/**
 * The state `step-source-iteration.ts` cannot read off the pass (#2475 2d).
 *
 * No `allocateExpressId`: that phase never allocates an id, it only rewrites
 * lines that already have one. `applySourceLineMutations` (a free function in
 * `step-attribute-mutations.ts`, closed over `mutationView` here) and
 * `isGeometryEntity` are injected rather than read off the pass because each
 * has readers outside this phase — the mutation pipeline is shared with the
 * type-object `HasPropertySets` rewrite (see `StepExporter`'s
 * `propertySetContext`, which stays a method because it mints express ids) and
 * with the overlay-created-entities block in `export()`; `isGeometryEntity`
 * with the visible-only setup closure and that same block.
 *
 * `propertySetContext` arrives as a THUNK, not a value: the phase calls it
 * per use and the original method rebuilt it per call, which is the behaviour
 * being preserved.
 */
export function buildSourceIterationContext(
  dataStore: IfcDataStore,
  mutationView: MutablePropertyView | null,
  propertySetContext: () => PropertySetContext,
): SourceIterationContext {
  return {
    dataStore,
    applySourceLineMutations: (expressId, entityText, recordType, attributeMutations, sourceSchema, overlayActive, onRejected) =>
      applySourceLineMutations(mutationView, expressId, entityText, recordType, attributeMutations, sourceSchema, overlayActive, onRejected),
    isGeometryEntity,
    propertySetContext,
    relationshipWithheldWarning,
  };
}

/**
 * The state `step-overlay-entities.ts` cannot read off the pass (#2475
 * step 2e). `applyOverlayEntityOverrides` is the free function
 * `step-overlay-attribute-overrides.ts` exports; `isGeometryEntity` and
 * `relationshipWithheldWarning` are the same shared readers
 * {@link buildSourceIterationContext} already injects into the other output
 * pass.
 */
export function buildOverlayEntitiesContext(
  mutationView: MutablePropertyView | null,
): OverlayEntitiesContext {
  return {
    mutationView,
    applyOverlayEntityOverrides,
    isGeometryEntity,
    relationshipWithheldWarning,
  };
}
