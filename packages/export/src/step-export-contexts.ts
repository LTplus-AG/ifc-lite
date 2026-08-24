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
 * its closure gives each builder its own sequence and silently emits two
 * entities with the same `#N`. Nothing in the suite currently catches a
 * duplicate express id (`findDanglingRefs` collects ids into a `Set`, which
 * absorbs the duplicate), so the cost of getting it wrong is invisible.
 *
 * That is the whole reason this module holds two functions rather than five.
 */

import type { IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import { applySourceLineMutations, applyOverlayEntityOverrides } from './step-attribute-mutations.js';
import { relationshipWithheldWarning } from './step-export-types.js';
import { isGeometryEntity } from './step-geometry-types.js';
import type { SourceIterationContext } from './step-source-iteration.js';
import type { OverlayEntitiesContext } from './step-overlay-entities.js';
import type { PropertySetContext } from './step-property-sets.js';

/**
   * The state `step-source-iteration.ts` cannot read off the pass (#2475 2d).
   *
   * No `allocateExpressId`: that phase never allocates an id, it only rewrites
   * lines that already have one. `applySourceLineMutations` (#2475, remaining
   * private helpers: now a free function in `step-attribute-mutations.ts`,
   * closed over `this.mutationView` here) and `isGeometryEntity` are injected
   * rather than read off the pass because each has readers outside this
   * phase — the mutation pipeline is shared with the type-object
   * `HasPropertySets` rewrite (see `StepExporter`'s `propertySetContext`, which
   * stays a method because it mints express ids) and with the
   * overlay-created-entities block in `export()`; `isGeometryEntity` with the
   * visible-only setup closure and that same block.
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
   * step 2e). `applyOverlayEntityOverrides` is now the free function
   * `step-attribute-mutations.ts` exports (#2475, remaining private
   * helpers) — it and its two `serializeNamedAttribute` /
   * `serializePositionalOverride` helpers moved together, since those two
   * have no reader outside this cluster; `isGeometryEntity` and
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
