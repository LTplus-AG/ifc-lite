/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IFC STEP file exporter
 *
 * Exports IFC data store to ISO 10303-21 STEP format.
 * Supports applying property and root attribute mutations before export.
 */

import type { IfcDataStore, IfcSourceHeader } from '@ifc-lite/parser';
import { EntityExtractor, parseSourceHeader } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import { needsConversion, type IfcSchemaVersion } from './schema-converter.js';
import { getCompleteEntityIndex, getMaxExpressId } from './entity-iteration.js';
import { createSourceRefReader } from './source-ref-bounds.js';
import { writeSourceEntityLines } from './step-source-iteration.js';
import { writeOverlayCreatedEntities } from './step-overlay-entities.js';
import { generatePropertyAndQuantitySetEntities } from './step-property-sets.js';
import {
  type OwnerHistoryCache,
  type PropertySetContext,
} from './step-property-set-readers.js';
import { type GeorefContext } from './step-georeferencing.js';
import { collectModifications, type CollectionContext } from './step-collection.js';
import { assembleExportResult } from './step-header.js';
import { applySourceLineMutations } from './step-attribute-mutations.js';

/**
 * The export vocabulary lives in `step-export-types.ts` (#2475). Re-exported
 * here, unchanged, so that the package entry point and the seven sibling
 * modules that import `ExportPass` / `SourceLineMutations` from this file
 * carry on doing exactly that -- the split moved declarations, not call sites.
 */
export type {
  StepExportOptions,
  StepExportProgress,
  StepExportResult,
  SourceLineMutations,
  ExportPass,
} from './step-export-types.js';
// Only the three this file's own body still names. `StepExportProgress` and
// `SourceLineMutations` are re-exported above but never referenced here, and
// importing them too raises TS6196 under --noUnusedLocals.
import type { StepExportOptions, StepExportResult, ExportPass } from './step-export-types.js';
import { buildExportPass } from './step-pass-builder.js';
import { evaluateOmissionPredicates } from './step-omission-predicates.js';
import { isGeometryEntity } from './step-geometry-types.js';
import {
  buildSourceIterationContext,
  buildOverlayEntitiesContext,
} from './step-export-contexts.js';


/**
 * IFC STEP file exporter
 */
export class StepExporter {
  private dataStore: IfcDataStore;
  private mutationView: MutablePropertyView | null;
  private nextExpressId: number;
  private entityExtractor: EntityExtractor | null;
  /**
   * The owner-history memos the property-set and quantity-set generators read.
   *
   * Owned here and handed to `step-property-set-readers.ts` BY REFERENCE rather than
   * stored on its context: the reset below is an `export()`-level statement,
   * and the comment there is where "per export, not per exporter" is argued.
   * Moving the storage into a per-export context would make that reset
   * implicit — the same invariant, in a place nothing says it (#2475 step 2b).
   */
  private ownerHistory: OwnerHistoryCache = { fallbackRef: undefined, byEntity: new Map() };
  /**
   * "Can this record's line actually be read out of this store's source?"
   * (`source-ref-bounds.ts`, #2491). Built once — `dataStore` is assigned in
   * the constructor and never reassigned — so the gates outside `export`'s
   * closure share one predicate instead of rebuilding it per call.
   */
  private isReadableSourceRef: ReturnType<typeof createSourceRefReader>;

  constructor(dataStore: IfcDataStore, mutationView?: MutablePropertyView) {
    this.dataStore = dataStore;
    this.isReadableSourceRef = createSourceRefReader(dataStore.source);
    this.mutationView = mutationView || null;
    const maxExisting = this.findMaxExpressId();
    const overlayWatermark = typeof mutationView?.peekNextExpressId === 'function'
      ? mutationView.peekNextExpressId() - 1
      : 0;
    this.nextExpressId = Math.max(maxExisting, overlayWatermark) + 1;
    this.entityExtractor = dataStore.source ? new EntityExtractor(dataStore.source) : null;
  }

  /**
   * Export to STEP format
   */
  export(options: StepExportOptions): StepExportResult {
    // Both owner-history caches are per-EXPORT, not per-exporter: they now
    // depend on `willBeEmitted`, which depends on this call's options. Reusing
    // one exporter for a `visibleOnly` export and then a full one would
    // otherwise answer the second from the first one's closure.
    this.ownerHistory.fallbackRef = undefined;
    this.ownerHistory.byEntity.clear();

    // Determine target schema from options, source schema from data store
    const schema = options.schema || (this.dataStore.schemaVersion as IfcSchemaVersion) || 'IFC4';
    const sourceSchema = (this.dataStore.schemaVersion as IfcSchemaVersion) || 'IFC4';
    const converting = needsConversion(sourceSchema, schema);

    // Read ONCE, here, and consumed everywhere below instead of re-spelling
    // `options.applyMutations !== false` per site. `options` is the caller's
    // object and this export re-enters it dozens of times; an accessor that
    // answered differently on the second read would have let the effective
    // index be built WITH the overlay while a later guard — including the
    // relationship-filter precondition — decided there was none. Reading each
    // option that feeds that precondition exactly once makes the two agree by
    // construction rather than by every site happening to spell it the same
    // way (adversarial review of #2668's replacement gate).
    const applyMutations = options.applyMutations !== false;
    // Same, for the other option the precondition reads. `isGeometryExcluded`
    // below and both output passes' own geometry skips consume this one const,
    // so "the gate thinks geometry is included while the predicate thinks it is
    // excluded" is not a state this export can reach.
    const excludeGeometry = options.includeGeometry === false;

    if (
      schema === 'IFC2X3' &&
      applyMutations &&
      options.georefMutations &&
      (
        Object.keys(options.georefMutations.projectedCRS ?? {}).length > 0 ||
        Object.keys(options.georefMutations.mapConversion ?? {}).length > 0
      )
    ) {
      throw new Error('Georeferencing creation and editing requires IFC4 or newer. IFC2X3 does not support IfcProjectedCRS or IfcMapConversion.');
    }

    // Round-trip header fidelity: prefer the verbatim source HEADER fields so
    // a re-export reproduces the original FILE_DESCRIPTION items + exact
    // FILE_SCHEMA token instead of a fresh ifc-lite header. The parser stores
    // `sourceHeader`; fall back to parsing the (always-present) source bytes so
    // cache-restored stores — which don't carry `sourceHeader` — still work.
    const sourceHeader: IfcSourceHeader | undefined =
      this.dataStore.sourceHeader
      ?? (this.dataStore.source.byteLength > 0
        ? parseSourceHeader(this.dataStore.source)
        : undefined);

    // Preserve the exact FILE_SCHEMA identifier (e.g. IFC4X3_ADD2) only when we
    // are NOT converting schemas; conversion must emit the coarse target token.
    const schemaToken: string =
      !converting && sourceHeader?.schemaIdentifiers?.[0]
        ? sourceHeader.schemaIdentifiers[0]
        : schema;

    // The one construction site for the state this export shares across its
    // seven phases, built in `step-pass-builder.ts` (#2475). `ExportPass` in
    // `step-export-types.ts` says what belongs on it and what deliberately
    // does not.
    //
    // What comes back is the object the phases below MUTATE -- notably
    // `collectModifications`, which fills in the `allowedEntityIds` /
    // `hiddenProductIds` that the pass's own predicates close over. Do not
    // copy it; `step-pass-builder.test.ts` is what stops that.
    const pass: ExportPass = buildExportPass({
      dataStore: this.dataStore,
      mutationView: this.mutationView,
      isGeometryEntity,
      options,
      schema,
      sourceSchema,
      converting,
      applyMutations,
      excludeGeometry,
      sourceHeader,
      schemaToken,
    });

    // Visible-only closure, overlay mutation grouping, and georeferencing
    // edits — everything `pass` needs before the omission predicates below,
    // and before the output passes that consume them, can run (#2475, the
    // collection block).
    collectModifications(pass, options, applyMutations, this.collectionContext());

    // Which ids this export may still NAME, now that the collection phase has
    // decided which ids it is WRITING (#2475). Must stay here, between those
    // two -- see `step-omission-predicates.ts` for why the position is load
    // bearing rather than stylistic.
    const omission = evaluateOmissionPredicates(
      pass,
      options,
      applyMutations,
      excludeGeometry,
      this.mutationView,
    );
    // A deltaOnly export with nothing to say is already finished.
    if (omission.kind === 'short-circuit') return omission.result;
    const { isOmittedFromOutput, mayNameOmittedRefs } = omission;

    // Write every source-backed record this export keeps (#2475 step 2d),
    // preceded — inside that call — by the shared-atom retention that decides
    // which member atoms the skip sets may still drop.
    writeSourceEntityLines(pass, options, mayNameOmittedRefs, isOmittedFromOutput, buildSourceIterationContext(this.dataStore, this.mutationView, () => this.propertySetContext()));

    // Generated property/quantity sets and the type-object `HasPropertySets`
    // rewrite that resolves against them, in that one order (#2475 steps 2b
    // and 2c). `pass.rewrittenEntityLines`, this call's output, is flushed
    // just below — after the quantity-set loop inside it, as it always was.
    generatePropertyAndQuantitySetEntities(pass, options, this.propertySetContext());

    for (const rewrittenLine of pass.rewrittenEntityLines.values()) {
      pass.entities.push(rewrittenLine);
    }

    // Add new georeferencing entities (IfcProjectedCRS, IfcMapConversion)
    for (const line of pass.newGeorefLines) {
      pass.entities.push(line);
    }

    // Add overlay-created entities (store.addEntity / mutationView.createEntity),
    // applying the same filters as the source-iteration pass (#2475 step 2e).
    writeOverlayCreatedEntities(
      pass,
      options,
      excludeGeometry,
      applyMutations,
      mayNameOmittedRefs,
      isOmittedFromOutput,
      buildOverlayEntitiesContext(this.mutationView),
    );

    // Settle the ledger, build the header, assemble the finished bytes —
    // `step-header.ts` (#2475 header/assembly tail).
    return assembleExportResult(pass);
  }

  /**
   * Async export that yields to the event loop periodically, keeping the
   * UI responsive during large exports. Calls onProgress with live stats.
   */
  async exportAsync(options: StepExportOptions): Promise<StepExportResult> {
    const onProgress = options.onProgress;

    // Report preparing phase
    const totalEntities = getCompleteEntityIndex(this.dataStore).size;
    if (onProgress) onProgress({ phase: 'preparing', percent: 0, entitiesProcessed: 0, entitiesTotal: totalEntities });
    await new Promise(r => setTimeout(r, 0));

    // The sync export does the heavy lifting — we can't easily break it into
    // chunks without duplicating the entire method, so we report phases around it.
    if (onProgress) onProgress({ phase: 'entities', percent: 0.1, entitiesProcessed: 0, entitiesTotal: totalEntities });
    await new Promise(r => setTimeout(r, 0));

    const result = this.export(options);

    if (onProgress) onProgress({ phase: 'assembling', percent: 0.95, entitiesProcessed: totalEntities, entitiesTotal: totalEntities });
    await new Promise(r => setTimeout(r, 0));

    return result;
  }

  /**
   * Export only property/quantity changes (lightweight export)
   */
  exportPropertiesOnly(options: Omit<StepExportOptions, 'includeGeometry'>): StepExportResult {
    return this.export({
      ...options,
      includeGeometry: false,
      deltaOnly: true,
    });
  }

  /**
   * Find the maximum EXPRESS ID in the data store
   */
  private findMaxExpressId(): number {
    // Span deferred property atoms too, so newly allocated ids can't collide
    // with a deferred entity sitting at a higher express id than anything in byId.
    return getMaxExpressId(getCompleteEntityIndex(this.dataStore));
  }

  /**
   * The exporter state `step-georeferencing.ts` cannot read off the pass.
   *
   * `allocateExpressId` hands out ids from THIS exporter's `nextExpressId`,
   * which the property-set and quantity-set generators in
   * `step-property-set-generators.ts` increment at six further sites through the same
   * callback — hoisting the counter onto the pass would change what it
   * computes, not merely where it is named, so both phases get a callback
   * instead (#2475 step 2a).
   */
  private georefContext(deltaOnly: boolean): GeorefContext {
    return {
      dataStore: this.dataStore,
      entityExtractor: this.entityExtractor,
      allocateExpressId: () => this.nextExpressId++,
      deltaOnly,
    };
  }

  /**
   * The state the property-set phase cannot read off the pass (#2475 2b/2c).
   *
   * `allocateExpressId` is the same callback `georefContext` hands out, over
   * the same counter, so the ids the two phases allocate stay in one sequence.
   * `ownerHistory` is passed by reference — the object is this exporter's, and
   * `export()` resets it. `isReadableSourceRef` is the instance predicate, not
   * `pass.isReadableSourceRef`, because two consumers of that module
   * (`buildRelDefinesByPropertiesIndex`, and `retainSharedAtoms` in
   * `step-source-iteration.ts`) run with no pass in hand; both readers are
   * built over the same source.
   *
   * Rebuilt per call, as `georefContext` is: every call site runs once per
   * export bar `retainSharedAtoms`, which hoists it out of its loop — hence
   * `buildSourceIterationContext` (`step-export-contexts.ts`) takes this as a
   * thunk rather than a value.
   */
  private propertySetContext(): PropertySetContext {
    return {
      dataStore: this.dataStore,
      entityExtractor: this.entityExtractor,
      mutationView: this.mutationView,
      isReadableSourceRef: this.isReadableSourceRef,
      allocateExpressId: () => this.nextExpressId++,
      ownerHistory: this.ownerHistory,
      applySourceLineMutations: (expressId, entityText, recordType, attributeMutations, sourceSchema, overlayActive, onRejected) =>
        applySourceLineMutations(this.mutationView, expressId, entityText, recordType, attributeMutations, sourceSchema, overlayActive, onRejected),
    };
  }

  /**
   * The state `step-collection.ts` cannot read off the pass (#2475, the
   * collection block). `propertySetContext` and `georefContext` are handed
   * over as the SAME thunks {@link propertySetContext} and
   * {@link georefContext} already are — this phase calls the first twice per
   * export and the second once, and nothing here should change how often
   * either is rebuilt.
   */
  private collectionContext(): CollectionContext {
    return {
      dataStore: this.dataStore,
      mutationView: this.mutationView,
      propertySetContext: () => this.propertySetContext(),
      georefContext: (deltaOnly) => this.georefContext(deltaOnly),
    };
  }



}

/**
 * Quick export function for simple use cases.
 * Returns content as a string (may fail for very large files due to V8 string limit).
 * For large files, use StepExporter directly and work with the Uint8Array content.
 */
export function exportToStep(
  dataStore: IfcDataStore,
  options?: Partial<StepExportOptions>
): string {
  const exporter = new StepExporter(dataStore);
  const result = exporter.export({
    // Default to the SOURCE schema, not a hardcoded 'IFC4'. A hardcoded
    // default silently schema-CONVERTED every non-IFC4 file passed without an
    // explicit `schema` (an IFC2X3 or IFC4X3 model re-emitted under a
    // `FILE_SCHEMA(('IFC4'))` header — mislabeled, and invalid wherever the
    // source used schema-specific entities). This matches `export()`'s own
    // `options.schema || dataStore.schemaVersion || 'IFC4'` fallback and the
    // `?? store.schemaVersion ?? 'IFC4'` every internal caller already spells
    // out, so wrapper and class agree by construction.
    schema: (dataStore.schemaVersion as IfcSchemaVersion) || 'IFC4',
    ...options,
  });
  return new TextDecoder().decode(result.content);
}
