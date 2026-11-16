/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Turn a `bim.georef` request into a write plan, or refuse it.
 *
 * The plan is executed by `session.ts` through the paths the exporter
 * already has: IFC4/IFC4X3 entities go to `StepExporter`'s
 * `georefMutations` (`@ifc-lite/export` `step-georeferencing.ts`, the same
 * writer the viewer's georeferencing panel drives), replaced records are
 * tombstoned in the mutation view, and IFC2X3's convention property sets
 * are ordinary property edits. This module writes no STEP itself.
 *
 * Fail-closed rules (openBIM-surveyor style): no CRS, unit, scale or factor
 * is ever guessed; there must be a context (IFC4+) or a site (IFC2X3) to
 * anchor to; an existing georeferencing is only replaced on an explicit
 * `replace`; and a write that would leave contradicting values is refused.
 */

import type { StepExportOptions } from '@ifc-lite/export';
import { EPSET_MAP_CONVERSION, EPSET_PROJECTED_CRS, idList, type EPSetLocation, type GeorefModelFacts } from './model-facts.js';
import { describeSet } from './epset-locator.js';
import { compact, emptyGeoreferencingState, rotationOf } from './read.js';
import { rejectUnknownKeys, requireMapUnit, requireNumber, requirePresent, requireText, resolveFactors, resolveRotation } from './validate.js';
import {
  GeoreferencingError,
  type GeorefMapConversionAttributes,
  type GeorefMapConversionState,
  type GeorefMapUnitDecision,
  type GeorefProjectedCRSAttributes,
  type GeorefStorage,
  type GeoreferencingSetInput,
  type GeoreferencingState,
} from './types.js';

export type StepGeorefMutations = NonNullable<StepExportOptions['georefMutations']>;

/**
 * The measure types the convention gives its properties (buildingSMART
 * "User Guide for Geo-referencing in IFC" 2020, and IfcOpenShell's
 * `ePSet_Georeferencing.ifc` template): lengths, reals, IfcText for
 * Description, IfcLabel for the CRS name and the rest of the CRS text.
 */
export type EPSetDataType = 'IfcLengthMeasure' | 'IfcReal' | 'IfcLabel' | 'IfcText';

/** One IFC2X3 convention-set edit, applied through the mutation view. */
export type PropertySetOp =
  | { op: 'deleteSet'; hostId: number; pset: string }
  /** An empty set under a (host, name) this plan deleted: the view keeps a deleted set's name masked, a created one shows. */
  | { op: 'createSet'; hostId: number; pset: string }
  | { op: 'set'; hostId: number; pset: string; prop: string; value: string | number; dataType: EPSetDataType }
  | { op: 'deleteProperty'; hostId: number; pset: string; prop: string };

export interface GeorefWritePlan {
  action: 'set' | 'update' | 'remove';
  storage: GeorefStorage;
  tombstone: number[];
  removed: string[];
  /** The session's new pending `georefMutations`: replace (object), clear (null). */
  georefMutations: StepGeorefMutations | null;
  propertySetOps: PropertySetOp[];
  next: GeoreferencingState;
  mapUnit: GeorefMapUnitDecision | null;
  notes: string[];
}

export interface PlanContext {
  modelId: string;
  facts: GeorefModelFacts;
  /** The effective state: source plus this session's earlier georeferencing writes. */
  current: GeoreferencingState;
  /** This session's pending `georefMutations`, when it has written before. */
  pending: StepGeorefMutations | null;
  /** What the reader reports once every georeferencing record and set is gone (the IfcSite fallback, if any). */
  afterRemove(withPropertySets: boolean): GeoreferencingState;
}

export const CRS_FIELDS = Object.freeze(['Name', 'Description', 'GeodeticDatum', 'VerticalDatum', 'MapProjection', 'MapZone', 'MapUnit'] as const);
export const MC_FIELDS = Object.freeze(['Eastings', 'Northings', 'OrthogonalHeight', 'XAxisAbscissa', 'XAxisOrdinate', 'Scale', 'FactorX', 'FactorY', 'FactorZ'] as const);

/** The exporter's camelCase key for an EXPRESS attribute name. */
export function exporterKey(attr: string): string {
  return attr.charAt(0).toLowerCase() + attr.slice(1);
}

/** The contexts the planner would convert from, in its order, travel with the mutations; the exporter takes the first one still there. */
export function withSourceCrs(m: StepGeorefMutations, facts: GeorefModelFacts): StepGeorefMutations {
  return facts.rankedContexts.length === 0 ? m : { ...m, sourceCrs: facts.rankedContexts };
}

export function toExporterMutations(
  crs: Partial<GeorefProjectedCRSAttributes> | null,
  mc: Partial<GeorefMapConversionAttributes> | null,
): StepGeorefMutations {
  const out: StepGeorefMutations = {};
  const pick = (src: Record<string, unknown>, fields: readonly string[]) =>
    Object.fromEntries(fields.filter((f) => src[f] !== undefined).map((f) => [exporterKey(f), src[f]]));
  if (crs && Object.keys(crs).length > 0) out.projectedCRS = pick(crs, CRS_FIELDS);
  if (mc && Object.keys(mc).length > 0) out.mapConversion = pick(mc, MC_FIELDS);
  return out;
}

export function requireStorage(facts: GeorefModelFacts): GeorefStorage {
  if (facts.storage) return facts.storage;
  throw new GeoreferencingError(
    'UNSUPPORTED_SCHEMA',
    `Georeferencing can be written to IFC2X3 (ePSet_MapConversion/ePSet_ProjectedCRS), IFC4 and IFC4X3 models; this model is ${facts.schema || 'of unknown schema'}.`,
  );
}

/** The anchor an IfcMapConversion (or the IFC2X3 sets) hangs off, or a refusal. */
export function requireAnchor(facts: GeorefModelFacts, storage: GeorefStorage): number {
  if (storage === 'entities') {
    if (facts.contexts.length === 0) {
      throw new GeoreferencingError(
        'NO_ANCHOR',
        'The model has no IfcGeometricRepresentationContext, so an IfcMapConversion has no SourceCRS to convert from. Nothing was written.',
        ['IfcGeometricRepresentationContext'],
      );
    }
    return facts.contexts[0];
  }
  if (facts.sites.length === 0) {
    throw new GeoreferencingError(
      'NO_ANCHOR',
      'The model has no IfcSite to carry the IFC2X3 ePSet_MapConversion/ePSet_ProjectedCRS property sets. Nothing was written.',
      ['IfcSite'],
    );
  }
  if (facts.sites.length > 1) {
    throw new GeoreferencingError(
      'AMBIGUOUS',
      `The model has ${facts.sites.length} IfcSites (${idList(facts.sites)}); the IFC2X3 property-set convention names one. Nothing was written.`,
    );
  }
  return facts.sites[0];
}

/** The georeferencing records a `set --replace` or `remove` deletes. */
function existingRecords(facts: GeorefModelFacts): Array<{ id: number; label: string }> {
  const crsIds = new Set([...facts.projectedCRS, ...facts.geographicCRS]);
  return [
    ...facts.mapConversions.map(({ id, scaled }) => ({ id, label: `${scaled ? 'IfcMapConversionScaled' : 'IfcMapConversion'} #${id}` })),
    ...facts.rigidOperations.map((id) => ({ id, label: `IfcRigidOperation #${id}` })),
    ...facts.projectedCRS.map((id) => ({ id, label: `IfcProjectedCRS #${id}` })),
    ...facts.geographicCRS.map((id) => ({ id, label: `IfcGeographicCRS #${id}` })),
    // A definition of a CRS that is going away would be left pointing at nothing.
    ...facts.wellKnownText.filter((w) => w.crs !== null && crsIds.has(w.crs)).map(({ id }) => ({ id, label: `IfcWellKnownText #${id}` })),
  ];
}

function existingEPSets(facts: GeorefModelFacts): string[] {
  return facts.ePSets.map(describeSet);
}

/** Deleting every copy of the convention sets, by identity: a delete per host and name, and the unattached ones tombstoned. */
export function deleteCopyOps(sets: readonly EPSetLocation[]): { ops: PropertySetOp[]; tombstone: number[] } {
  const hosted = new Map(sets.filter((p) => p.orphan === undefined).map((p) => [`${p.hostId}|${p.name}`, p]));
  return {
    ops: [...hosted.values()].map((p) => ({ op: 'deleteSet' as const, hostId: p.hostId, pset: p.name })),
    tombstone: sets.flatMap((p) => (p.orphan === undefined ? [] : [p.orphan])),
  };
}

/**
 * A replace removes every map conversion but writes one, against the
 * exporter's preferred context. When the old ones covered several contexts
 * (Model and Plan, say), the others are left without one: say which.
 */
function contextNotes(facts: GeorefModelFacts): string[] {
  const covered = [...new Set(facts.mapConversions.map((m) => m.sourceCrs).filter((id): id is number => id !== null))];
  const label = (id: number) => `#${id} '${facts.contextTypes.get(id) ?? ''}'`;
  const kept = facts.preferredContext;
  const lost = covered.filter((id) => id !== kept);
  if (lost.length === 0) return [];
  return [
    `The replaced map conversions covered ${covered.length} representation context${covered.length === 1 ? '' : 's'} (${covered.map(label).join(', ')}). The new IfcMapConversion is written for ${kept === null ? 'one context' : label(kept)} only, so ${lost.map(label).join(', ')} ${lost.length === 1 ? 'is' : 'are'} no longer georeferenced; ifc-lite does not write one conversion per context yet.`,
  ];
}

export function siteNotes(facts: GeorefModelFacts): string[] {
  return facts.sitesWithLatLong.length === 0 ? [] : [
    `IfcSite ${idList(facts.sitesWithLatLong)} also carries RefLatitude/RefLongitude. They were left as they are, and ifc-lite does not check them against the map position (no reprojection here).`,
  ];
}

/** `ProjectedCRS.MapUnit` for a new CRS: explicit, or the same-named CRS being replaced. */
function decideMapUnit(input: GeorefProjectedCRSAttributes, current: GeoreferencingState): GeorefMapUnitDecision {
  if (input.MapUnit !== undefined) {
    return { value: requireMapUnit(input.MapUnit), source: 'explicit', detail: 'given explicitly' };
  }
  const prior = current.ProjectedCRS;
  const sameName = prior?.Name?.trim().toUpperCase() === input.Name.trim().toUpperCase();
  const where = prior?.expressId !== undefined ? `${prior.type} #${prior.expressId}` : `this session's ${prior?.type}`;
  if (prior && sameName && prior.MapUnit !== undefined) {
    if (prior.mapUnitResolved === false) {
      throw unresolvedMapUnit(where);
    }
    return {
      value: requireMapUnit(prior.MapUnit, `MapUnit of ${where}`),
      source: 'existing',
      detail: `carried over from ${where}, which has the same Name`,
    };
  }
  throw new GeoreferencingError(
    'MISSING_INPUT',
    `ProjectedCRS.MapUnit is required: ifc-lite does not guess the unit of ${JSON.stringify(input.Name)}, carries no CRS database to derive it from, and the model has no IfcProjectedCRS of that Name to take it from. Pass it explicitly (e.g. METRE).`,
    ['ProjectedCRS.MapUnit'],
  );
}

/** The refusal for carrying a MapUnit the reader only defaulted. */
export function unresolvedMapUnit(where: string): GeoreferencingError {
  return new GeoreferencingError(
    'MISSING_INPUT',
    `ProjectedCRS.MapUnit is required: the MapUnit of ${where} could not be resolved (ifc-lite reads it as a METRE default, which may be wrong) or was changed outside bim.georef, so it is not carried over. Pass ProjectedCRS.MapUnit explicitly (e.g. METRE, US SURVEY FOOT).`,
    ['ProjectedCRS.MapUnit'],
  );
}

/** Validated, complete attribute sets for a `set`. */
export function resolveFullInput(
  input: Pick<GeoreferencingSetInput, 'ProjectedCRS' | 'MapConversion' | 'rotationDegrees'>,
  ctx: PlanContext,
): { crs: GeorefProjectedCRSAttributes; mc: GeorefMapConversionAttributes; mapUnit: GeorefMapUnitDecision; notes: string[] } {
  const crsIn = (input.ProjectedCRS ?? {}) as Partial<GeorefProjectedCRSAttributes>;
  const mcIn = (input.MapConversion ?? {}) as Partial<GeorefMapConversionAttributes>;
  requirePresent([
    ['ProjectedCRS.Name', crsIn.Name],
    ['MapConversion.Eastings', mcIn.Eastings],
    ['MapConversion.Northings', mcIn.Northings],
    ['MapConversion.OrthogonalHeight', mcIn.OrthogonalHeight],
  ], 'A georeferencing');
  const crs: GeorefProjectedCRSAttributes = { Name: requireText(crsIn.Name, 'ProjectedCRS.Name') };
  for (const f of CRS_FIELDS.slice(1, 6)) {
    if (crsIn[f] !== undefined) crs[f] = requireText(crsIn[f], `ProjectedCRS.${f}`);
  }
  const mapUnit = decideMapUnit({ ...crs, MapUnit: crsIn.MapUnit }, ctx.current);
  crs.MapUnit = mapUnit.value;

  const mc: GeorefMapConversionAttributes = {
    Eastings: requireNumber(mcIn.Eastings, 'MapConversion.Eastings'),
    Northings: requireNumber(mcIn.Northings, 'MapConversion.Northings'),
    OrthogonalHeight: requireNumber(mcIn.OrthogonalHeight, 'MapConversion.OrthogonalHeight'),
  };
  const notes: string[] = [];
  const rotation = resolveRotation(mcIn, input.rotationDegrees);
  if (rotation.given === 'none') {
    notes.push('No rotation given: XAxisAbscissa/XAxisOrdinate are left unset, which IFC reads as no rotation.');
  } else {
    mc.XAxisAbscissa = rotation.XAxisAbscissa;
    mc.XAxisOrdinate = rotation.XAxisOrdinate;
  }
  if (mcIn.Scale !== undefined) mc.Scale = requireNumber(mcIn.Scale, 'MapConversion.Scale', { positive: true });
  const factors = resolveFactors(mcIn, ctx.facts.fileSchema, ctx.facts.supportsScaled && ctx.facts.storage === 'entities');
  if (factors) [mc.FactorX, mc.FactorY, mc.FactorZ] = factors;
  return { crs, mc, mapUnit, notes };
}

/** The state a plan leaves behind. */
export function stateAfter(
  ctx: Pick<PlanContext, 'modelId' | 'facts'>,
  storage: GeorefStorage,
  crs: GeorefProjectedCRSAttributes | null,
  mc: GeorefMapConversionAttributes | null,
  ids: { crs?: number; mc?: number } = {},
): GeoreferencingState {
  const state = emptyGeoreferencingState(ctx.modelId, ctx.facts.schema);
  state.pending = true;
  if (!crs && !mc) return state;
  state.hasGeoreference = true;
  const scaled = mc?.FactorX !== undefined;
  const mcType: GeorefMapConversionState['type'] = storage === 'propertySets' ? 'ePSet_MapConversion' : scaled ? 'IfcMapConversionScaled' : 'IfcMapConversion';
  state.source = mc ? mcType : null;
  if (crs) {
    state.ProjectedCRS = compact({ ...crs, mapUnitResolved: crs.MapUnit === undefined ? undefined : true, type: storage === 'propertySets' ? 'ePSet_ProjectedCRS' as const : 'IfcProjectedCRS' as const, expressId: ids.crs });
  }
  if (mc) {
    state.MapConversion = compact({ ...mc, type: mcType, expressId: ids.mc });
    state.rotationDegrees = rotationOf(mc);
  }
  return state;
}

export const EPSET_DATA_TYPES: Readonly<Record<string, EPSetDataType>> = Object.freeze({
  Eastings: 'IfcLengthMeasure', Northings: 'IfcLengthMeasure', OrthogonalHeight: 'IfcLengthMeasure',
  XAxisAbscissa: 'IfcReal', XAxisOrdinate: 'IfcReal', Scale: 'IfcReal',
  Description: 'IfcText',
});

export function ePSetValues(src: Record<string, unknown>, fields: readonly string[]): Array<[string, string | number, EPSetDataType]> {
  return fields
    .filter((f) => src[f] !== undefined)
    .map((f) => [f, src[f] as string | number, EPSET_DATA_TYPES[f] ?? 'IfcLabel']);
}

const SET_KEYS = ['ProjectedCRS', 'MapConversion', 'rotationDegrees', 'replace'] as const;

export function planSet(input: GeoreferencingSetInput, ctx: PlanContext): GeorefWritePlan {
  rejectUnknownKeys(input, SET_KEYS, '');
  rejectUnknownKeys(input.ProjectedCRS, CRS_FIELDS, 'ProjectedCRS');
  rejectUnknownKeys(input.MapConversion, MC_FIELDS, 'MapConversion');
  const storage = requireStorage(ctx.facts);
  const anchor = requireAnchor(ctx.facts, storage);
  const records = storage === 'entities' ? existingRecords(ctx.facts) : [];
  // Convention sets are read from every schema (the reader's fallback), so they count as existing whatever the storage.
  const epsets = existingEPSets(ctx.facts);
  const sessionOnly = ctx.current.pending && (ctx.current.ProjectedCRS || ctx.current.MapConversion || ctx.current.RigidOperation) && records.length === 0 && epsets.length === 0;
  const existing = [...records.map((r) => r.label), ...epsets, ...(sessionOnly ? ['the georeferencing set earlier in this session'] : [])];
  if (existing.length > 0 && input.replace !== true) {
    throw new GeoreferencingError(
      'ALREADY_GEOREFERENCED',
      `The model is already georeferenced (${existing.join(', ')}). Pass replace: true (CLI --replace) to remove that and write the new one, or use update to change single values.`,
      ['replace'],
    );
  }
  const { crs, mc, mapUnit, notes } = resolveFullInput(input, ctx);
  if (existing.length > 0) notes.push(`Replaced: ${existing.join(', ')}.`);
  if (storage === 'entities') notes.push(...contextNotes(ctx.facts));
  notes.push(...siteNotes(ctx.facts));
  const base = {
    action: 'set' as const, storage, mapUnit, notes,
    next: stateAfter(ctx, storage, crs, mc),
    removed: [...records.map((r) => r.label), ...epsets],
  };
  // A replace removes every copy of the convention sets (any host, or none). IFC2X3 then has one pair under the
  // convention's own spelling: a lone copy on the anchor is rewritten in place, otherwise a fresh pair is written
  // (an explicit `createSet` after the delete: the view keeps a deleted set's name masked otherwise).
  const lone = (canonical: string) => {
    const here = ctx.facts.ePSets.filter((p) => p.orphan === undefined && p.hostId === anchor && p.name.toLowerCase() === canonical.toLowerCase());
    return here.length === 1 ? here[0] : null;
  };
  const keep = storage === 'propertySets' ? [lone(EPSET_MAP_CONVERSION), lone(EPSET_PROJECTED_CRS)] : [];
  const gone = deleteCopyOps(ctx.facts.ePSets.filter((p) => !keep.includes(p)));
  if (storage === 'entities') {
    return { ...base, tombstone: [...records.map((r) => r.id), ...gone.tombstone], georefMutations: withSourceCrs(toExporterMutations(crs, mc), ctx.facts), propertySetOps: gone.ops };
  }
  const deletedHere = new Set(gone.ops.filter((o) => o.hostId === anchor).map((o) => o.pset));
  const write = (canonical: string, kept: EPSetLocation | null, values: Array<[string, string | number, EPSetDataType]>): PropertySetOp[] => {
    const pset = kept?.name ?? canonical;
    const wanted = new Set(values.map(([prop]) => prop));
    return [
      ...(!kept && deletedHere.has(pset) ? [{ op: 'createSet' as const, hostId: anchor, pset }] : []),
      ...Object.keys(kept?.values ?? {}).filter((prop) => !wanted.has(prop)).map((prop) => ({ op: 'deleteProperty' as const, hostId: anchor, pset, prop })),
      ...values.map(([prop, value, dataType]) => ({ op: 'set' as const, hostId: anchor, pset, prop, value, dataType })),
    ];
  };
  return {
    ...base,
    tombstone: gone.tombstone,
    georefMutations: null,
    propertySetOps: [
      ...gone.ops,
      ...write(EPSET_MAP_CONVERSION, keep[0], ePSetValues(mc as unknown as Record<string, unknown>, MC_FIELDS)),
      ...write(EPSET_PROJECTED_CRS, keep[1], ePSetValues(crs as unknown as Record<string, unknown>, CRS_FIELDS)),
    ],
  };
}

export function planRemove(ctx: PlanContext): GeorefWritePlan {
  const storage = requireStorage(ctx.facts);
  const records = storage === 'entities' ? existingRecords(ctx.facts) : [];
  const sets = ctx.facts.ePSets;
  const gone = deleteCopyOps(sets);
  if (records.length === 0 && sets.length === 0 && !(ctx.current.pending && ctx.current.hasGeoreference)) {
    throw new GeoreferencingError('NOT_GEOREFERENCED', 'The model carries no IfcMapConversion, IfcRigidOperation, CRS or IFC2X3 ePSet_MapConversion to remove.');
  }
  return {
    action: 'remove',
    storage,
    tombstone: [...records.map((r) => r.id), ...gone.tombstone],
    removed: [...records.map((r) => r.label), ...sets.map(describeSet)],
    georefMutations: null,
    propertySetOps: gone.ops,
    next: { ...ctx.afterRemove(storage === 'propertySets' || sets.length > 0), pending: true },
    mapUnit: null,
    notes: siteNotes(ctx.facts),
  };
}
