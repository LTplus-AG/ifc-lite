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
import { escapeStepString, toStepReal } from './step-serialization.js';
import type { ExportPass, StepExportOptions } from './step-exporter.js';

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
  const existingMcIds = pass.effective.byType.get('IFCMAPCONVERSION');

  // Modify existing IfcProjectedCRS
  if (gm.projectedCRS && existingCrsIds?.length) {
    const entityId = existingCrsIds[0];
    if (!pass.modifiedAttributes.has(entityId)) {
      pass.modifiedAttributes.set(entityId, new Map());
    }
    const attrMap = pass.modifiedAttributes.get(entityId)!;
    const crs = gm.projectedCRS;
    let changed = false;
    if (crs.name !== undefined) { attrMap.set('Name', String(crs.name)); changed = true; }
    if (crs.description !== undefined) { attrMap.set('Description', String(crs.description)); changed = true; }
    if (crs.geodeticDatum !== undefined) { attrMap.set('GeodeticDatum', String(crs.geodeticDatum)); changed = true; }
    if (crs.verticalDatum !== undefined) { attrMap.set('VerticalDatum', String(crs.verticalDatum)); changed = true; }
    if (crs.mapProjection !== undefined) { attrMap.set('MapProjection', String(crs.mapProjection)); changed = true; }
    if (crs.mapZone !== undefined) { attrMap.set('MapZone', String(crs.mapZone)); changed = true; }
    if (crs.mapUnit !== undefined) {
      const mapUnitRef = resolveMapUnitReference(String(crs.mapUnit), pass.newGeorefLines, pass.effective, ctx);
      attrMap.set('MapUnit', `#${mapUnitRef}`);
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
    const mapUnitRef = crs.mapUnit
      ? `#${resolveMapUnitReference(String(crs.mapUnit), pass.newGeorefLines, pass.effective, ctx)}`
      : '$';
    pass.newGeorefLines.push(`#${crsId}=IFCPROJECTEDCRS(${name},${desc},${datum},${vDatum},${proj},${zone},${mapUnitRef});`);
    pass.newEntityCount++;

    // Find IfcGeometricRepresentationContext as SourceCRS for MapConversion
    const contextId = findPreferredGeometricRepresentationContextId(pass.effective, ctx);

    if (contextId) {
      const mc = gm.mapConversion || {};
      const mcId = ctx.allocateExpressId();
      const eastings = toStepReal(Number(mc.eastings) || 0);
      const northings = toStepReal(Number(mc.northings) || 0);
      const height = toStepReal(Number(mc.orthogonalHeight) || 0);
      const abscissa = mc.xAxisAbscissa !== undefined ? toStepReal(Number(mc.xAxisAbscissa)) : '$';
      const ordinate = mc.xAxisOrdinate !== undefined ? toStepReal(Number(mc.xAxisOrdinate)) : '$';
      const scale = mc.scale !== undefined ? toStepReal(Number(mc.scale)) : '$';
      // IfcMapConversion(SourceCRS, TargetCRS, Eastings, Northings, OrthogonalHeight, XAxisAbscissa, XAxisOrdinate, Scale)
      pass.newGeorefLines.push(`#${mcId}=IFCMAPCONVERSION(#${contextId},#${crsId},${eastings},${northings},${height},${abscissa},${ordinate},${scale});`);
      pass.newEntityCount++;
    } else {
      reportMapConversionRefused(pass.warnings);
    }
  } else if (gm.mapConversion && !existingMcIds?.length && existingCrsIds?.length) {
    // CRS exists but no MapConversion — create just the conversion
    const contextId = findPreferredGeometricRepresentationContextId(pass.effective, ctx);
    if (contextId) {
      const mc = gm.mapConversion;
      const mcId = ctx.allocateExpressId();
      const eastings = toStepReal(Number(mc.eastings) || 0);
      const northings = toStepReal(Number(mc.northings) || 0);
      const height = toStepReal(Number(mc.orthogonalHeight) || 0);
      const abscissa = mc.xAxisAbscissa !== undefined ? toStepReal(Number(mc.xAxisAbscissa)) : '$';
      const ordinate = mc.xAxisOrdinate !== undefined ? toStepReal(Number(mc.xAxisOrdinate)) : '$';
      const scale = mc.scale !== undefined ? toStepReal(Number(mc.scale)) : '$';
      pass.newGeorefLines.push(`#${mcId}=IFCMAPCONVERSION(#${contextId},#${existingCrsIds[0]},${eastings},${northings},${height},${abscissa},${ordinate},${scale});`);
      pass.newEntityCount++;
    } else {
      reportMapConversionRefused(pass.warnings);
    }
  } else if (gm.mapConversion && !existingMcIds?.length && !existingCrsIds?.length) {
    // A map conversion was requested, but there is no IfcProjectedCRS to
    // reference as TargetCRS: none was requested (the first branch above
    // didn't fire) and none exists in the file. Both CREATE branches are
    // skipped, so nothing is attempted — report the refusal so the
    // caller isn't left with an empty stats.warnings and no hint (#2105).
    reportMapConversionRefusedNoCrs(pass.warnings);
  }
}

export function resolveMapUnitReference(unitName: string, newGeorefLines: string[], effective: EffectiveEntityIndex, ctx: GeorefContext): number {
  const normalized = normalizeMapUnitName(unitName);
  const existing = findLengthUnitReference(normalized, effective, ctx);
  if (existing !== null) {
    return existing;
  }

  if (normalized === 'METRE') {
    const unitId = ctx.allocateExpressId();
    newGeorefLines.push(`#${unitId}=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);`);
    return unitId;
  }

  if (normalized === 'FOOT' || normalized === 'US SURVEY FOOT') {
    const dimId = ctx.allocateExpressId();
    const siUnitId = ctx.allocateExpressId();
    const measureId = ctx.allocateExpressId();
    const convUnitId = ctx.allocateExpressId();
    const factor = normalized === 'US SURVEY FOOT' ? 1200 / 3937 : 0.3048;
    const name = normalized === 'US SURVEY FOOT' ? 'US SURVEY FOOT' : 'FOOT';
    newGeorefLines.push(`#${dimId}=IFCDIMENSIONALEXPONENTS(1,0,0,0,0,0,0);`);
    newGeorefLines.push(`#${siUnitId}=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);`);
    newGeorefLines.push(`#${measureId}=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(${toStepReal(factor)}),#${siUnitId});`);
    newGeorefLines.push(`#${convUnitId}=IFCCONVERSIONBASEDUNIT(#${dimId},.LENGTHUNIT.,'${name}',#${measureId});`);
    return convUnitId;
  }

  const fallbackId = ctx.allocateExpressId();
  newGeorefLines.push(`#${fallbackId}=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);`);
  return fallbackId;
}

export function normalizeMapUnitName(unitName: string): string {
  const normalized = unitName.trim().toUpperCase().replace(/\s+/g, ' ');
  if (normalized.includes('US SURVEY FOOT')) return 'US SURVEY FOOT';
  if (normalized.includes('METER') || normalized.includes('METRE')) return 'METRE';
  if (normalized.includes('FOOT') || normalized.includes('FEET')) return 'FOOT';
  return normalized;
}

/**
 * `effective` filters the candidates the same way the georef reads above do:
 * returning a tombstoned unit id hands the caller a `#id` for a line the
 * export never writes. Returning null instead makes `resolveMapUnitReference`
 * synthesise a fresh unit, which is the outcome a deleted unit deserves.
 */
export function findLengthUnitReference(preferredUnitName: string, effective: EffectiveEntityIndex, ctx: GeorefLookupContext): number | null {
  if (!ctx.entityExtractor) return null;

  // Only source records carry the bytes `extractEntity` reads, so an
  // overlay-created project is skipped rather than shadowing the file's own.
  const projectId = (effective.byType.get('IFCPROJECT') ?? []).find((id) => ctx.dataStore.entityIndex.byId.has(id));
  const projectRef = projectId !== undefined ? ctx.dataStore.entityIndex.byId.get(projectId) : undefined;
  const project = projectRef ? ctx.entityExtractor.extractEntity(projectRef) : null;
  const unitAssignmentId = project?.attributes?.[8];
  if (typeof unitAssignmentId !== 'number' || effective.isDeleted(unitAssignmentId)) return null;

  const unitAssignmentRef = ctx.dataStore.entityIndex.byId.get(unitAssignmentId);
  const unitAssignment = unitAssignmentRef ? ctx.entityExtractor.extractEntity(unitAssignmentRef) : null;
  const units = unitAssignment?.attributes?.[0];
  if (!Array.isArray(units)) return null;

  for (const unitId of units) {
    if (typeof unitId !== 'number' || effective.isDeleted(unitId)) continue;
    const unitRef = ctx.dataStore.entityIndex.byId.get(unitId);
    const unit = unitRef ? ctx.entityExtractor.extractEntity(unitRef) : null;
    if (!unit) continue;

    const typeName = unit.type.toUpperCase();
    const attrs = unit.attributes ?? [];
    const unitType = typeof attrs[1] === 'string' ? attrs[1].replace(/\./g, '').toUpperCase() : '';
    if (unitType !== 'LENGTHUNIT') continue;

    if (typeName === 'IFCSIUNIT') {
      const prefix = typeof attrs[2] === 'string' ? attrs[2].replace(/\./g, '').toUpperCase() : '';
      const name = typeof attrs[3] === 'string' ? attrs[3].replace(/\./g, '').toUpperCase() : '';
      const combined = prefix ? `${prefix}${name}` : name;
      if (preferredUnitName === 'METRE' && (combined === 'METRE' || combined === 'METER')) {
        return unitId;
      }
    }

    if (typeName === 'IFCCONVERSIONBASEDUNIT') {
      const name = typeof attrs[2] === 'string' ? normalizeMapUnitName(attrs[2]) : '';
      if (name === preferredUnitName) {
        return unitId;
      }
    }
  }

  return null;
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

  const contextIds = (effective.byType.get('IFCGEOMETRICREPRESENTATIONCONTEXT') ?? [])
    .filter((id) => ctx.dataStore.entityIndex.byId.has(id));
  let first3dContext: number | null = null;

  for (const contextId of contextIds) {
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
