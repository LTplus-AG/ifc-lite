/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The georeferencing phase of `StepExporter.export()` (#2475 step 2a): the
 * `IfcProjectedCRS` / `IfcMapConversion` edits and creations, plus the map-unit
 * and representation-context resolution they depend on.
 *
 * Unlike `step-file-assembly.ts` and `type-owned-psets.ts`, this phase is not a
 * pure function of its inputs: it allocates express ids from the exporter's own
 * counter and reads the store through the exporter's `EntityExtractor`. Those
 * three dependencies are injected as {@link GeorefContext} rather than hoisted
 * onto the pass — `nextExpressId` is incremented at six further, unrelated
 * sites in the exporter, so moving it would change what it computes, not merely
 * where it is named. The callback follows
 * `type-owned-psets.ts:resolveTypeOwnedPsetIds` and its `nameOf` callback.
 *
 * {@link applyGeoreferencingMutations} mutates the pass in place and returns
 * nothing, because two consumers read its output at a distance: the `deltaOnly`
 * empty-export early return checks `pass.newGeorefLines.length`, and the
 * assembly loop some 330 lines later is where those lines become bytes.
 */

import type { IfcDataStore, EntityExtractor } from '@ifc-lite/parser';
import type { EffectiveEntityIndex } from './effective-index.js';
import { escapeStepString, textEdit, toStepReal } from './step-serialization.js';
import type { ExportPass, StepExportOptions } from './step-exporter.js';
import { reportMapUnitUnsupported, resolveMapUnitReference } from './step-map-unit.js';

/**
 * Message for the one refusal `export()` can report, shared by the returned
 * `stats.warnings` entry and the console line so the two cannot drift.
 */
const MAP_CONVERSION_WITHOUT_CONTEXT_WARNING =
  'Cannot create IfcMapConversion: no IfcGeometricRepresentationContext is available to reference as SourceCRS. The IfcProjectedCRS is unaffected.';

/**
 * Message for the refusal `export()` reports when a map conversion is
 * requested but there is no IfcProjectedCRS to attach it to — none was
 * requested and none exists in the file — distinct from
 * {@link MAP_CONVERSION_WITHOUT_CONTEXT_WARNING}, which is worded for the
 * case where an IfcProjectedCRS exists (or was written) but no context is
 * available to reference.
 */
const MAP_CONVERSION_WITHOUT_CRS_WARNING =
  'Cannot create IfcMapConversion: no IfcProjectedCRS was requested and none exists in the file to reference as TargetCRS. Nothing was written.';

/**
 * Every concrete class carrying an IfcMapConversion's attributes, in the
 * UPPERCASE spelling `EffectiveEntityIndex.byType` is keyed by. Kept beside
 * `@ifc-lite/parser`'s `MAP_CONVERSION_TYPE_NAMES`, which is the same list in
 * the mixed-case spelling the read path uses — the reader and the writer must
 * agree on what counts as a map conversion, or the exporter duplicates a
 * record the reader can see.
 */
const MAP_CONVERSION_STEP_TYPES: readonly string[] = [
  'IFCMAPCONVERSION',
  'IFCMAPCONVERSIONSCALED',
];

/**
 * The exporter state this phase cannot read off the pass.
 *
 * `allocateExpressId` is `StepExporter`'s own `nextExpressId++`, injected so
 * that the ids this phase hands out stay in the same sequence as every other
 * allocation in the export.
 */
export interface GeorefLookupContext {
  readonly dataStore: IfcDataStore;
  readonly entityExtractor: EntityExtractor | null;
}

export interface GeorefContext extends GeorefLookupContext {
  /** `() => this.nextExpressId++` on the exporter. */
  readonly allocateExpressId: () => number;
  /** `options.deltaOnly === true`: the only option this phase reads beyond
   *  `georefMutations` itself, and the one that decides whether an edit the
   *  delta cannot carry is nominated to the ledger. */
  readonly deltaOnly: boolean;
}

/**
 * Apply `options.georefMutations` to `pass`, in place.
 *
 * The caller owns the `options.applyMutations !== false && options.georefMutations`
 * gate; reaching here means georeferencing edits were both requested and enabled.
 */
export function applyGeoreferencingMutations(
  pass: ExportPass,
  georefMutations: NonNullable<StepExportOptions['georefMutations']>,
  ctx: GeorefContext,
): void {
  const gm = georefMutations;
  // `effective.byType`, not the raw index: a source IfcProjectedCRS the
  // session tombstoned is still in `dataStore.entityIndex`, so the modify
  // branch below would queue attribute edits against an id the
  // source-iteration pass then skips — the replacement georeferencing
  // vanishes from the file with no error. `effective.byType` drops
  // tombstones and adds overlay-created records, which the new-entities
  // pass applies `modifiedAttributes` to, so both branches agree on which
  // georeferencing entities exist (#2048).
  const existingCrsIds = pass.effective.byType.get('IFCPROJECTEDCRS');
  // `byType` is keyed by the RAW STEP type name, so the supertype key alone
  // does not see IFC4X3's concrete IfcMapConversionScaled. Missing it left a
  // file that HAS a map conversion looking like one that has none: the modify
  // branch below found nothing, and a create branch ran instead — emitting a
  // SECOND coordinate operation against the same source CRS while the file's
  // own scaled one stayed put, which is not a file any consumer can read
  // unambiguously. The six attributes edited below are IfcMapConversion's own
  // and are edited BY NAME, which the scaled subtype inherits unchanged, so
  // modifying it in place is well-defined (its extra FactorX/Y/Z sit after
  // them and are left alone).
  const existingMcIds = MAP_CONVERSION_STEP_TYPES.flatMap(
    (typeName) => pass.effective.byType.get(typeName) ?? [],
  );

  // Modify existing IfcProjectedCRS
  if (gm.projectedCRS && existingCrsIds?.length) {
    const entityId = existingCrsIds[0];
    if (!pass.modifiedAttributes.has(entityId)) {
      pass.modifiedAttributes.set(entityId, new Map());
    }
    const attrMap = pass.modifiedAttributes.get(entityId)!;
    const crs = gm.projectedCRS;
    let changed = false;
    if (crs.name !== undefined) { attrMap.set('Name', textEdit(crs.name)); changed = true; }
    if (crs.description !== undefined) { attrMap.set('Description', textEdit(crs.description)); changed = true; }
    if (crs.geodeticDatum !== undefined) { attrMap.set('GeodeticDatum', textEdit(crs.geodeticDatum)); changed = true; }
    if (crs.verticalDatum !== undefined) { attrMap.set('VerticalDatum', textEdit(crs.verticalDatum)); changed = true; }
    if (crs.mapProjection !== undefined) { attrMap.set('MapProjection', textEdit(crs.mapProjection)); changed = true; }
    if (crs.mapZone !== undefined) { attrMap.set('MapZone', textEdit(crs.mapZone)); changed = true; }
    if (crs.mapUnit !== undefined) {
      const mapUnitRef = resolveMapUnitReference(String(crs.mapUnit), pass.newGeorefLines, ctx);
      // A refused unit clears MapUnit rather than leaving the file's own in
      // place: the caller asked for a DIFFERENT unit, so the one already
      // there is known to be wrong, and `$` is the only honest answer this
      // exporter can write (#3274).
      if (mapUnitRef === null) {
        reportMapUnitUnsupported(pass.warnings, String(crs.mapUnit));
        attrMap.set('MapUnit', '$');
      } else {
        attrMap.set('MapUnit', `#${mapUnitRef}`);
      }
      changed = true;
    }
    if (changed) {
      pass.modifiedEntities.add(entityId);
      // Queued as attribute edits, which only the source-iteration pass
      // writes — so under `deltaOnly` this nominates and settle decides.
      // Recorded even when the host is already in `modifiedEntities`: that
      // guard existed to stop a second COUNT, which the ledger now handles
      // per entity, and suppressing the nomination would hide a dropped
      // georeferencing edit behind an unrelated edit to the same record.
      //
      // `changed` above is INTENT — a field was supplied, not a field that
      // differs from the one in the file. Writing `name: 'EPSG:2056'` over
      // an IfcProjectedCRS already named `EPSG:2056` leaves the line
      // byte-identical, so a full export waits for the rewrite exactly as
      // the plain attribute site does (#2483).
      if (pass.hasEmittableHostBytes(entityId)) {
        pass.inPlaceNominees.georeferencing.add(entityId);
        if (ctx.deltaOnly) pass.modifications.nominate(entityId, 'georeferencing');
      }
    }
  }

  // Modify existing IfcMapConversion
  if (gm.mapConversion && existingMcIds?.length) {
    const entityId = existingMcIds[0];
    if (!pass.modifiedAttributes.has(entityId)) {
      pass.modifiedAttributes.set(entityId, new Map());
    }
    const attrMap = pass.modifiedAttributes.get(entityId)!;
    const mc = gm.mapConversion;
    let changed = false;
    if (mc.eastings !== undefined) { attrMap.set('Eastings', String(mc.eastings)); changed = true; }
    if (mc.northings !== undefined) { attrMap.set('Northings', String(mc.northings)); changed = true; }
    if (mc.orthogonalHeight !== undefined) { attrMap.set('OrthogonalHeight', String(mc.orthogonalHeight)); changed = true; }
    if (mc.xAxisAbscissa !== undefined) { attrMap.set('XAxisAbscissa', String(mc.xAxisAbscissa)); changed = true; }
    if (mc.xAxisOrdinate !== undefined) { attrMap.set('XAxisOrdinate', String(mc.xAxisOrdinate)); changed = true; }
    if (mc.scale !== undefined) { attrMap.set('Scale', String(mc.scale)); changed = true; }
    // FactorX/Y/Z exist only on IFC4X3's IfcMapConversionScaled. Editing them
    // on a plain IfcMapConversion would need a class change this branch does
    // not make, so it is refused rather than silently dropped.
    const factors = requestedFactors(mc, pass.warnings);
    if (factors) {
      if (pass.effective.byType.get('IFCMAPCONVERSIONSCALED')?.includes(entityId)) {
        // Raw values, like the six attributes above (and the Rust twin).
        attrMap.set('FactorX', String(mc.factorX));
        attrMap.set('FactorY', String(mc.factorY));
        attrMap.set('FactorZ', String(mc.factorZ));
        changed = true;
      } else {
        reportGeorefWarning(pass.warnings, FACTORS_ON_UNSCALED_WARNING);
      }
    }
    if (changed) {
      pass.modifiedEntities.add(entityId);
      // Same as the IfcProjectedCRS branch above, effect gate included.
      if (pass.hasEmittableHostBytes(entityId)) {
        pass.inPlaceNominees.georeferencing.add(entityId);
        if (ctx.deltaOnly) pass.modifications.nominate(entityId, 'georeferencing');
      }
    }
  }

  // CREATE new georef entities when file has none
  if (gm.projectedCRS && !existingCrsIds?.length) {
    const crs = gm.projectedCRS;
    const crsId = ctx.allocateExpressId();
    // IfcProjectedCRS(Name, Description, GeodeticDatum, VerticalDatum, MapProjection, MapZone, MapUnit)
    const name = crs.name ? `'${escapeStepString(String(crs.name))}'` : '$';
    const desc = crs.description ? `'${escapeStepString(String(crs.description))}'` : '$';
    const datum = crs.geodeticDatum ? `'${escapeStepString(String(crs.geodeticDatum))}'` : '$';
    const vDatum = crs.verticalDatum ? `'${escapeStepString(String(crs.verticalDatum))}'` : '$';
    const proj = crs.mapProjection ? `'${escapeStepString(String(crs.mapProjection))}'` : '$';
    const zone = crs.mapZone ? `'${escapeStepString(String(crs.mapZone))}'` : '$';
    let mapUnitRef = '$';
    // `!== undefined`, as in the existing-CRS path: an empty MapUnit is one this exporter cannot express, and the caller is told.
    if (crs.mapUnit !== undefined) {
      const resolved = resolveMapUnitReference(String(crs.mapUnit), pass.newGeorefLines, ctx);
      if (resolved === null) reportMapUnitUnsupported(pass.warnings, String(crs.mapUnit));
      else mapUnitRef = `#${resolved}`;
    }
    pass.newGeorefLines.push(`#${crsId}=IFCPROJECTEDCRS(${name},${desc},${datum},${vDatum},${proj},${zone},${mapUnitRef});`);
    pass.newEntityCount++;

    if (gm.mapConversion) createMapConversion(pass, ctx, crsId, gm.mapConversion, gm.sourceCrs);
    else if (!existingMcIds?.length && !gm.sourceCrs?.length) throw new Error(`${UNPLANNED_REFUSAL} no position was given for the new IfcProjectedCRS.`);
  } else if (gm.mapConversion && !existingMcIds?.length && existingCrsIds?.length) {
    // CRS exists but no MapConversion — create just the conversion
    createMapConversion(pass, ctx, existingCrsIds[0], gm.mapConversion, gm.sourceCrs);
  } else if (gm.mapConversion && !existingMcIds?.length && !existingCrsIds?.length) {
    // A map conversion was requested, but there is no IfcProjectedCRS to
    // reference as TargetCRS: none was requested (the first branch above
    // didn't fire) and none exists in the file. Both CREATE branches are
    // skipped, so nothing is attempted — report the refusal so the
    // caller isn't left with an empty stats.warnings and no hint (#2105).
    reportMapConversionRefusedNoCrs(pass.warnings);
  }
}

/**
 * FILE_SCHEMA identifiers whose schema declares `IfcMapConversionScaled`.
 * Of the schemas bundled in `packages/codegen/schemas/`, only `IFC4X3.exp`
 * (`IFC4X3_DEV_923b0514`, a post-RC4 development snapshot of what was
 * released as IFC4X3_ADD2) declares it; `IFC4_ADD2_TC1`, `IFC4X1` and
 * `IFC4X2` do not, and no `IFC4X3_RC*` schema is bundled to say otherwise.
 * `IFC4X3` is the bare family identifier, which this exporter writes as
 * `IFC4X3_ADD2` (#5351). Anything else, the RC identifiers among them, fails
 * closed.
 */
const SCALED_FILE_SCHEMAS: ReadonlySet<string> = new Set(['IFC4X3', 'IFC4X3_ADD2']);

/** Whether a file declaring FILE_SCHEMA `fileSchema` may contain `IfcMapConversionScaled`. */
export function declaresMapConversionScaled(fileSchema: string): boolean {
  return SCALED_FILE_SCHEMAS.has(fileSchema.trim().toUpperCase());
}

function scaledUndeclaredWarning(fileSchema: string): string {
  return `Cannot write IfcMapConversionScaled into a file declaring FILE_SCHEMA ${fileSchema}: that schema does not declare it (only IFC4X3 / IFC4X3_ADD2 do). FactorX/FactorY/FactorZ were not written, and the IfcMapConversion was written without them.`;
}

/** A partial factor triple: IfcMapConversionScaled declares all three as mandatory. */
const PARTIAL_FACTORS_WARNING =
  'Cannot write IfcMapConversionScaled: FactorX, FactorY and FactorZ are all mandatory and must be finite numbers, and the triple given was not. The factors were not written.';

/** Factors requested for a record that is a plain IfcMapConversion. */
const FACTORS_ON_UNSCALED_WARNING =
  'Cannot write FactorX/FactorY/FactorZ onto an existing IfcMapConversion: they exist only on IfcMapConversionScaled, and this edit does not change the class. The factors were not written.';

type MapConversionRequest = NonNullable<NonNullable<StepExportOptions['georefMutations']>['mapConversion']>;

/**
 * Create an IfcMapConversion from a request. A create needs the whole position
 * (Eastings, Northings, OrthogonalHeight): a partial edit whose target record
 * no longer exists (deleted since) is refused with a warning, never written
 * with the missing fields guessed as 0.
 */
function createMapConversion(pass: ExportPass, ctx: GeorefContext, crsId: number, mc: MapConversionRequest, sourceCrs: readonly number[] | undefined): void {
  const given = (v: unknown) => v !== undefined && v !== null && !Number.isNaN(Number(v));
  if (![mc.eastings, mc.northings, mc.orthogonalHeight].every(given)) {
    // An unplanned caller (the viewer) never reads warnings: it gets a thrown error, not a 0-filled or dropped position.
    if (!sourceCrs?.length) throw new Error(`${UNPLANNED_REFUSAL} ${MAP_CONVERSION_INCOMPLETE_WARNING}`);
    reportGeorefWarning(pass.warnings, MAP_CONVERSION_INCOMPLETE_WARNING);
    return;
  }
  // The planner names the SourceCRS; a host that does not plan (the viewer) leaves it to the file's own contexts.
  const contextId = sourceCrs === undefined || sourceCrs.length === 0 ? findPreferredGeometricRepresentationContextId(pass.effective, ctx)
    : sourceCrs.find((id) => pass.effective.typeOf(id) === 'IFCGEOMETRICREPRESENTATIONCONTEXT') ?? null;
  if (!contextId) return reportMapConversionRefused(pass.warnings);
  pass.newGeorefLines.push(mapConversionLine(ctx.allocateExpressId(), contextId, crsId, mc, pass.warnings, pass.schemaToken));
  pass.newEntityCount++;
}

/**
 * The requested FactorX/Y/Z, or `null` when none was asked for. A partial
 * triple is reported and treated as none: IfcMapConversionScaled has no
 * optional factor, and filling the gap with 1.0 would be a guessed scale.
 */
function requestedFactors(mc: MapConversionRequest, warnings?: string[]): [number, number, number] | null {
  const given = [mc.factorX, mc.factorY, mc.factorZ];
  // A null is a factor nobody gave (`Number(null)` is 0, a mandatory FactorX of 0).
  if (given.every((f) => f == null)) return null;
  if (given.some((f) => f == null || !Number.isFinite(Number(f)))) {
    if (warnings) reportGeorefWarning(warnings, PARTIAL_FACTORS_WARNING);
    return null;
  }
  return given.map(Number) as [number, number, number];
}

/**
 * A new IfcMapConversion line — or IFC4X3's IfcMapConversionScaled when all
 * three factors were requested (its first eight attributes are the
 * supertype's, FactorX/Y/Z follow).
 */
function mapConversionLine(id: number, contextId: number, crsId: number, mc: MapConversionRequest, warnings: string[], fileSchema: string): string {
  const eastings = toStepReal(Number(mc.eastings) || 0);
  const northings = toStepReal(Number(mc.northings) || 0);
  const height = toStepReal(Number(mc.orthogonalHeight) || 0);
  const abscissa = mc.xAxisAbscissa !== undefined ? toStepReal(Number(mc.xAxisAbscissa)) : '$';
  const ordinate = mc.xAxisOrdinate !== undefined ? toStepReal(Number(mc.xAxisOrdinate)) : '$';
  const scale = mc.scale !== undefined ? toStepReal(Number(mc.scale)) : '$';
  // IfcMapConversion(SourceCRS, TargetCRS, Eastings, Northings, OrthogonalHeight, XAxisAbscissa, XAxisOrdinate, Scale)
  const head = `#${contextId},#${crsId},${eastings},${northings},${height},${abscissa},${ordinate},${scale}`;
  let factors = requestedFactors(mc, warnings);
  if (factors && !declaresMapConversionScaled(fileSchema)) {
    reportGeorefWarning(warnings, scaledUndeclaredWarning(fileSchema));
    factors = null;
  }
  return factors
    ? `#${id}=IFCMAPCONVERSIONSCALED(${head},${factors.map(toStepReal).join(',')});`
    : `#${id}=IFCMAPCONVERSION(${head});`;
}

const UNPLANNED_REFUSAL = 'Georeferencing was not exported:';
const MAP_CONVERSION_INCOMPLETE_WARNING = 'Cannot create IfcMapConversion from a partial edit: Eastings, Northings and OrthogonalHeight are all required.';

function reportGeorefWarning(warnings: string[], message: string): void {
  warnings.push(message);
  console.warn(`[StepExporter] ${message}`);
}

/**
 * Record that a requested IfcMapConversion could not be written. Emitting it
 * anyway would leave `SourceCRS` pointing at nothing, so the refusal is the
 * correct output — but the file alone cannot express it, which is why it goes
 * back to the caller in `stats.warnings` as well as to the console (#2067).
 */
function reportMapConversionRefused(warnings: string[]): void {
  warnings.push(MAP_CONVERSION_WITHOUT_CONTEXT_WARNING);
  console.warn(`[StepExporter] ${MAP_CONVERSION_WITHOUT_CONTEXT_WARNING}`);
}

/**
 * Record that a requested IfcMapConversion could not be written because
 * there is no IfcProjectedCRS to attach it to — a different refusal from
 * {@link reportMapConversionRefused}: "no CRS to attach it to" rather than
 * "no context to reference" (#2105).
 */
function reportMapConversionRefusedNoCrs(warnings: string[]): void {
  warnings.push(MAP_CONVERSION_WITHOUT_CRS_WARNING);
  console.warn(`[StepExporter] ${MAP_CONVERSION_WITHOUT_CRS_WARNING}`);
}

/**
 * `effective` again: the id returned here becomes the new IfcMapConversion's
 * SourceCRS, so a tombstoned context would leave the created line pointing at
 * a record the export skips — a dangling reference and an invalid file.
 */
function findPreferredGeometricRepresentationContextId(effective: EffectiveEntityIndex, ctx: GeorefLookupContext): number | null {
  if (!ctx.entityExtractor) return null;

  // @raw-entity-enumeration-ok effective.byType chooses live contexts; source byId only restricts to records this source-byte reader can decode
  const contextIds = (effective.byType.get('IFCGEOMETRICREPRESENTATIONCONTEXT') ?? [])
    .filter((id) => ctx.dataStore.entityIndex.byId.has(id));
  let first3dContext: number | null = null;

  for (const contextId of contextIds) {
    // @raw-entity-enumeration-ok point read of one source-backed effective context selected above
    const contextRef = ctx.dataStore.entityIndex.byId.get(contextId);
    const context = contextRef ? ctx.entityExtractor.extractEntity(contextRef) : null;
    if (!context) continue;

    const attrs = context.attributes ?? [];
    const contextType = typeof attrs[1] === 'string' ? attrs[1].trim().toUpperCase() : '';
    const dimension = typeof attrs[2] === 'number' ? attrs[2] : null;

    if (dimension === 3 && first3dContext === null) {
      first3dContext = contextId;
    }

    if (contextType === 'MODEL' && dimension === 3) {
      return contextId;
    }
  }

  return first3dContext ?? contextIds[0] ?? null;
}
