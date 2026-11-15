/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `bim.georef.update`: change single values of an existing georeferencing.
 * Split from `plan.ts` (module-size rule). The same fail-closed rules apply;
 * on top of them, an update refuses what it cannot do without a class change
 * (factors on a plain IfcMapConversion, an IfcRigidOperation, an
 * IfcGeographicCRS) and a CRS rename that would silently keep the old CRS's
 * datum or unit — those go through `set` with `replace`.
 */

import { EPSET_MAP_CONVERSION, EPSET_PROJECTED_CRS } from './model-facts.js';
import { describeSet } from './epset-locator.js';
import {
  CRS_FIELDS,
  MC_FIELDS,
  ePSetValues,
  requireAnchor,
  requireStorage,
  siteNotes,
  stateAfter,
  toExporterMutations,
  withSourceCrs,
  type GeorefWritePlan,
  type PlanContext,
  type PropertySetOp,
  unresolvedMapUnit,
} from './plan.js';
import { rejectUnknownKeys, requireMapUnit, requireNumber, requirePresent, requireText, resolveFactors, resolveRotation } from './validate.js';
import {
  GeoreferencingError,
  type GeorefMapConversionAttributes,
  type GeorefMapUnitDecision,
  type GeorefProjectedCRSAttributes,
  type GeoreferencingUpdateInput,
} from './types.js';

type Attrs = Record<string, unknown>;

const UPDATE_KEYS = ['ProjectedCRS', 'MapConversion', 'rotationDegrees'] as const;

function attributesOf(state: object | null, fields: readonly string[]): Attrs | null {
  if (!state) return null;
  const src = state as Attrs;
  return Object.fromEntries(fields.filter((f) => src[f] !== undefined).map((f) => [f, src[f]]));
}

function given(obj: Attrs): string[] {
  return Object.keys(obj).filter((k) => obj[k] !== undefined);
}

export function planUpdate(input: GeoreferencingUpdateInput, ctx: PlanContext): GeorefWritePlan {
  const storage = requireStorage(ctx.facts);
  const cur = ctx.current;
  rejectUnknownKeys(input, UPDATE_KEYS, '');
  rejectUnknownKeys(input.ProjectedCRS, CRS_FIELDS, 'ProjectedCRS');
  rejectUnknownKeys(input.MapConversion, MC_FIELDS, 'MapConversion');
  const crsIn = (input.ProjectedCRS ?? {}) as Attrs;
  const mcIn = (input.MapConversion ?? {}) as Attrs;
  if (given(crsIn).length + given(mcIn).length === 0 && input.rotationDegrees === undefined) {
    throw new GeoreferencingError('MISSING_INPUT', 'update was given nothing to change: pass ProjectedCRS and/or MapConversion attributes, or rotationDegrees.');
  }
  if (cur.RigidOperation) {
    throw new GeoreferencingError('UNSUPPORTED_RECORD', `The model is georeferenced with IfcRigidOperation #${cur.RigidOperation.expressId}; update edits an IfcMapConversion. Use set with replace to write an IfcMapConversion instead.`);
  }
  if (cur.ProjectedCRS?.type === 'IfcGeographicCRS') {
    throw new GeoreferencingError('UNSUPPORTED_RECORD', `The model's CRS is IfcGeographicCRS #${cur.ProjectedCRS.expressId}; update edits an IfcProjectedCRS. Use set with replace.`);
  }
  if (!cur.MapConversion && !cur.ProjectedCRS) {
    throw new GeoreferencingError('NOT_GEOREFERENCED', 'The model has no IfcMapConversion or IfcProjectedCRS (nor IFC2X3 ePSet_MapConversion) to update. Use set.');
  }
  const strays = ctx.facts.ePSets.filter((p) => !p.managed);
  if (storage === 'propertySets' && strays.length > 0) {
    throw new GeoreferencingError('AMBIGUOUS', `The model carries convention sets on objects the convention does not name (${strays.map(describeSet).join(', ')}); update would not know which to edit. Use set with replace: it removes them.`, ['replace']);
  }
  if (storage === 'propertySets' && ctx.facts.ePSets.length > [ctx.facts.ePSetMapConversion, ctx.facts.ePSetProjectedCRS].filter(Boolean).length) {
    throw new GeoreferencingError('AMBIGUOUS', `The model carries more than one copy of the convention sets (${ctx.facts.ePSets.map(describeSet).join(', ')}); update would not know which to edit. Use set with replace.`);
  }
  if (storage === 'entities' && ctx.facts.ePSets.length > 0 && ctx.facts.mapConversions.length === 0 && ctx.facts.projectedCRS.length === 0) {
    throw new GeoreferencingError('UNSUPPORTED_RECORD', `This ${ctx.facts.schema} model is georeferenced by convention property sets (${ctx.facts.ePSets.map(describeSet).join(', ')}), which update does not edit in an IFC4+ file. Use set with replace to write IfcMapConversion and replace them.`, ['replace']);
  }
  if (storage === 'entities' && (ctx.facts.mapConversions.length > 1 || ctx.facts.projectedCRS.length > 1)) {
    throw new GeoreferencingError('AMBIGUOUS', `The model has ${ctx.facts.mapConversions.length} IfcMapConversion and ${ctx.facts.projectedCRS.length} IfcProjectedCRS records; update would not know which to edit. Use set with replace.`);
  }

  // ---- ProjectedCRS ----
  const crsChanges: Attrs = {};
  for (const f of given(crsIn)) crsChanges[f] = f === 'MapUnit' ? requireMapUnit(crsIn[f]) : requireText(crsIn[f], `ProjectedCRS.${f}`);
  const curCrs = attributesOf(cur.ProjectedCRS, CRS_FIELDS);
  if (given(crsChanges).length > 0 && cur.ProjectedCRS?.wellKnownText) {
    throw new GeoreferencingError(
      'CONTRADICTION',
      `${cur.ProjectedCRS.type} #${cur.ProjectedCRS.expressId} is defined by an IfcWellKnownText; editing its attributes would leave the two disagreeing. Use set with replace.`,
    );
  }
  if (!curCrs && given(crsChanges).length > 0) requirePresent([['ProjectedCRS.Name', crsChanges.Name]], 'A new ePSet_ProjectedCRS');
  if (curCrs && crsChanges.Name !== undefined && String(crsChanges.Name).trim() !== String(curCrs.Name ?? '').trim()) {
    const carried = CRS_FIELDS.slice(1).filter((f) => curCrs[f] !== undefined && crsChanges[f] === undefined);
    if (carried.length > 0) {
      throw new GeoreferencingError(
        'CONTRADICTION',
        `Renaming the CRS from ${JSON.stringify(curCrs.Name)} to ${JSON.stringify(crsChanges.Name)} would keep ${carried.map((f) => `${f} ${JSON.stringify(curCrs[f])}`).join(', ')} from the old CRS. Restate ${carried.map((f) => `ProjectedCRS.${f}`).join(', ')} (unchanged values are fine), or use set with replace.`,
        carried.map((f) => `ProjectedCRS.${f}`),
      );
    }
  }
  const mergedCrs = curCrs || given(crsChanges).length > 0 ? { ...curCrs, ...crsChanges } as unknown as GeorefProjectedCRSAttributes : null;

  // ---- MapConversion ----
  const mcChanges: Attrs = {};
  for (const f of ['Eastings', 'Northings', 'OrthogonalHeight'] as const) {
    if (mcIn[f] !== undefined) mcChanges[f] = requireNumber(mcIn[f], `MapConversion.${f}`);
  }
  if (mcIn.Scale !== undefined) mcChanges.Scale = requireNumber(mcIn.Scale, 'MapConversion.Scale', { positive: true });
  if (mcIn.XAxisAbscissa !== undefined || mcIn.XAxisOrdinate !== undefined || input.rotationDegrees !== undefined) {
    const rotation = resolveRotation(mcIn as Partial<GeorefMapConversionAttributes>, input.rotationDegrees);
    mcChanges.XAxisAbscissa = rotation.XAxisAbscissa;
    mcChanges.XAxisOrdinate = rotation.XAxisOrdinate;
  }
  const curMc = attributesOf(cur.MapConversion, MC_FIELDS);
  if (mcIn.FactorX !== undefined || mcIn.FactorY !== undefined || mcIn.FactorZ !== undefined) {
    if (cur.MapConversion?.type === 'IfcMapConversion' && cur.MapConversion.expressId !== undefined) {
      throw new GeoreferencingError(
        'UNSUPPORTED_RECORD',
        `IfcMapConversion #${cur.MapConversion.expressId} is not an IfcMapConversionScaled, so it has no FactorX/FactorY/FactorZ; update does not change a record's class. Use set with replace to write an IfcMapConversionScaled.`,
        ['replace'],
      );
    }
    const factors = resolveFactors(
      { FactorX: (mcIn.FactorX === undefined ? curMc?.FactorX : mcIn.FactorX) as number, FactorY: (mcIn.FactorY === undefined ? curMc?.FactorY : mcIn.FactorY) as number, FactorZ: (mcIn.FactorZ === undefined ? curMc?.FactorZ : mcIn.FactorZ) as number },
      ctx.facts.fileSchema,
      ctx.facts.supportsScaled && storage === 'entities',
    );
    if (factors) [mcChanges.FactorX, mcChanges.FactorY, mcChanges.FactorZ] = factors;
  }
  const creatingMc = !curMc && given(mcChanges).length > 0;
  if (creatingMc) {
    requirePresent([
      ['MapConversion.Eastings', mcChanges.Eastings],
      ['MapConversion.Northings', mcChanges.Northings],
      ['MapConversion.OrthogonalHeight', mcChanges.OrthogonalHeight],
    ], 'A new IfcMapConversion');
    requireAnchor(ctx.facts, storage);
  }
  const mergedMc = curMc || creatingMc ? { ...curMc, ...mcChanges } as unknown as GeorefMapConversionAttributes : null;
  // An existing conversion whose coordinate is unset (an edit of the file) reads back as 0: update does not keep that, it asks.
  if (mergedMc && !creatingMc) {
    const absent = ['Eastings', 'Northings', 'OrthogonalHeight'].filter((f) => typeof (mergedMc as unknown as Attrs)[f] !== 'number');
    if (absent.length > 0) throw new GeoreferencingError('MISSING_INPUT', `The IfcMapConversion has no ${absent.join(', ')} (unset in the file); update would keep a value it does not know. Pass ${absent.map((f) => `MapConversion.${f}`).join(', ')}.`, absent.map((f) => `MapConversion.${f}`));
  }

  // ---- MapUnit: explicit or kept, never assumed ----
  let mapUnit: GeorefMapUnitDecision;
  if (crsChanges.MapUnit !== undefined) {
    mapUnit = { value: String(crsChanges.MapUnit), source: 'explicit', detail: 'given explicitly' };
  } else if (mergedCrs?.MapUnit !== undefined) {
    const where = cur.ProjectedCRS?.expressId !== undefined ? `${cur.ProjectedCRS.type} #${cur.ProjectedCRS.expressId}` : `this session's ${cur.ProjectedCRS?.type ?? 'CRS'}`;
    if (cur.ProjectedCRS?.mapUnitResolved === false) throw unresolvedMapUnit(where);
    mapUnit = { value: mergedCrs.MapUnit, source: 'existing', detail: `kept from ${where}` };
  } else {
    throw new GeoreferencingError(
      'MISSING_INPUT',
      `ProjectedCRS.MapUnit is required: the model's CRS declares no MapUnit, so the values being written would fall back to the project length unit, which ifc-lite does not assume for a map. Pass ProjectedCRS.MapUnit (e.g. METRE).`,
      ['ProjectedCRS.MapUnit'],
    );
  }

  const notes = siteNotes(ctx.facts);
  const next = stateAfter(ctx, storage, mergedCrs, mergedMc, { crs: cur.ProjectedCRS?.expressId, mc: cur.MapConversion?.expressId });
  const base = { action: 'update' as const, storage, tombstone: [], removed: [], next, mapUnit, notes };

  if (storage === 'propertySets') {
    const ops: PropertySetOp[] = [];
    const write = (location: typeof ctx.facts.ePSetMapConversion, canonical: string, changes: Attrs, fields: readonly string[]) => {
      if (given(changes).length === 0) return;
      const hostId = location?.hostId ?? requireAnchor(ctx.facts, storage);
      const pset = location?.name ?? canonical;
      for (const [prop, value, dataType] of ePSetValues(changes, fields)) ops.push({ op: 'set', hostId, pset, prop, value, dataType });
    };
    write(ctx.facts.ePSetMapConversion, EPSET_MAP_CONVERSION, mcChanges, MC_FIELDS);
    write(ctx.facts.ePSetProjectedCRS, EPSET_PROJECTED_CRS, crsChanges, CRS_FIELDS);
    // Some tools also name the CRS in ePSet_MapConversion.TargetCRS (the
    // reader falls back to it). A rename must carry it along, or the file
    // would name two CRSs.
    const mcSet = ctx.facts.ePSetMapConversion;
    if (crsChanges.Name !== undefined && mcSet && mcSet.values.TargetCRS !== undefined) {
      ops.push({ op: 'set', hostId: mcSet.hostId, pset: mcSet.name, prop: 'TargetCRS', value: String(crsChanges.Name), dataType: 'IfcLabel' });
    }
    return { ...base, georefMutations: null, propertySetOps: ops };
  }

  // A georeferencing this session created and has not exported is still a
  // creation: rewrite it whole. Otherwise edit the source records in place,
  // carrying earlier edits of this session forward.
  const sessionCreated = ctx.facts.mapConversions.length === 0 && ctx.facts.projectedCRS.length === 0;
  if (sessionCreated) {
    return { ...base, georefMutations: withSourceCrs(toExporterMutations(mergedCrs, mergedMc), ctx.facts), propertySetOps: [] };
  }
  const changes = toExporterMutations(crsChanges as Partial<GeorefProjectedCRSAttributes>, (creatingMc ? mergedMc : mcChanges) as Partial<GeorefMapConversionAttributes>);
  const prior = ctx.pending ?? {};
  const georefMutations = {
    ...(prior.projectedCRS || changes.projectedCRS ? { projectedCRS: { ...prior.projectedCRS, ...changes.projectedCRS } } : {}),
    ...(prior.mapConversion || changes.mapConversion ? { mapConversion: { ...prior.mapConversion, ...changes.mapConversion } } : {}),
  };
  return { ...base, georefMutations: withSourceCrs(georefMutations, ctx.facts), propertySetOps: [] };
}
