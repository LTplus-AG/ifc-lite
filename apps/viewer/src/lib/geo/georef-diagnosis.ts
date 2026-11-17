/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Georeference panel's diagnosis (#10608): `@ifc-lite/georef-check`
 * through the SDK's doctor, over the model as the user has edited it.
 *
 * The facts are read from the file once per store and the panel's unsaved
 * georeference edits (`georefMutations`) are laid over them, so the check
 * follows every edit without re-reading the file. A fix is offered only when
 * the SDK's planner marks it `ready` (no caveat, no value only the user can
 * supply) and it writes only fields this panel itself edits; it is applied
 * through `setGeorefFields` as one undo step.
 *
 * Loaded lazily (the section that imports it is behind `React.lazy`): the
 * checker, the CRS engine and the EPSG extents stay out of the entry chunk.
 */

import {
  checkGeorefFacts,
  collectGeorefFacts,
  planGeorefFixes,
  type CrsFact,
  type GeorefCheckReport,
  type GeorefFacts,
  type GeorefFinding,
  type GeorefPlannedFix,
  type OperationFact,
  type Severity,
} from '@ifc-lite/sdk/georef-doctor';
import { getEpsgAreaOfUse, type EpsgAreaOfUse } from '@ifc-lite/data';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { GeorefMutationData } from '@/store/slices/mutationSlice';

/** The `ProjectedCRS` fields the panel edits (camelCase, as `georefMutations` keys them). */
const CRS_FIELDS = ['name', 'description', 'geodeticDatum', 'verticalDatum', 'mapProjection', 'mapZone', 'mapUnit'] as const;
/** The `MapConversion` fields the panel edits. */
const CONVERSION_FIELDS = ['eastings', 'northings', 'orthogonalHeight', 'xAxisAbscissa', 'xAxisOrdinate', 'scale'] as const;

type CrsField = (typeof CRS_FIELDS)[number];
type ConversionField = (typeof CONVERSION_FIELDS)[number];

export interface GeorefFieldWrite {
  field: string;
  value: string | number;
  oldValue?: string | number;
}

/** What one fix writes, grouped as `setGeorefFields` takes it. */
export interface GeorefFixWrites {
  projectedCRS: GeorefFieldWrite[];
  mapConversion: GeorefFieldWrite[];
}

export interface DiagnosisFix {
  /** The planner's fix id (`ORTHOGONAL_HEIGHT_IMPLAUSIBLE.1`). */
  id: string;
  summary: string;
  writes: GeorefFixWrites;
}

export interface DiagnosisItem {
  finding: GeorefFinding;
  /** The finding's first `ready` fix the panel can write, when it has one. */
  fix?: DiagnosisFix;
}

export interface GeorefDiagnosis {
  report: GeorefCheckReport;
  /** Every finding, errors first, then warnings, then notes. */
  items: DiagnosisItem[];
  /**
   * The EPSG area of use of the CRS an `OUTSIDE_CRS_AREA` finding names:
   * `'unavailable'` when the EPSG extents failed to load, absent when there is
   * no such finding or EPSG records no area for the code.
   */
  outsideAreaOfUse?: EpsgAreaOfUse | 'unavailable';
}

function hasKeys(record: object | undefined): record is object {
  return !!record && Object.keys(record).length > 0;
}

/** Which georeferencing the edits address: IFC4 entities, else the IFC2X3 property sets. */
function editedSourceKey(facts: GeorefFacts): 'entities' | 'ePSet' {
  if (facts.entities) return 'entities';
  if (facts.ePSet) return 'ePSet';
  return facts.schemaVersion.toUpperCase().startsWith('IFC2X3') ? 'ePSet' : 'entities';
}

/**
 * The facts with the panel's unsaved edits laid over the georeferencing they
 * address. A conversion or CRS the edits create gets express id 0 (not yet
 * written). `mapUnitScale` is the edited CRS's metres per map unit, used when
 * MapUnit itself was edited.
 */
export function overlayGeorefEdits(facts: GeorefFacts, edits: GeorefMutationData | undefined, mapUnitScale?: number): GeorefFacts {
  if (!edits || (!hasKeys(edits.projectedCRS) && !hasKeys(edits.mapConversion))) return facts;
  const key = editedSourceKey(facts);
  const source = { ...facts[key] };
  const conversionEdits = edits.mapConversion;
  if (hasKeys(conversionEdits)) {
    const operation: OperationFact = {
      ...(source.operation ?? { source: key === 'ePSet' ? 'ePSet_MapConversion' : 'IfcMapConversion', entityId: 0, eastings: 0, northings: 0, orthogonalHeight: 0 }),
    };
    for (const field of CONVERSION_FIELDS) {
      const value = conversionEdits[field];
      if (typeof value === 'number' && Number.isFinite(value)) operation[field] = value;
    }
    source.operation = operation;
  }
  const crsEdits = edits.projectedCRS;
  if (hasKeys(crsEdits)) {
    const crs: CrsFact = { ...(source.crs ?? { source: key === 'ePSet' ? 'ePSet_ProjectedCRS' : 'IfcProjectedCRS', entityId: 0, name: '' }) };
    for (const field of CRS_FIELDS) {
      const value = crsEdits[field];
      if (typeof value === 'string') crs[field] = value;
    }
    if (typeof crsEdits.mapUnit === 'string') {
      if (mapUnitScale !== undefined) crs.mapUnitScale = mapUnitScale;
      else delete crs.mapUnitScale;
    }
    source.crs = crs;
  }
  return { ...facts, [key]: source };
}

const lowerFirst = (name: string): string => name.charAt(0).toLowerCase() + name.slice(1);

/**
 * A ready fix as `setGeorefFields` writes, or undefined when the panel cannot
 * write it: not `ready`, an IfcSite write, or a field the panel does not edit.
 * `oldValue`s come from the georeferencing the check read (edits included).
 */
export function fixWrites(fix: GeorefPlannedFix, facts: GeorefFacts): GeorefFixWrites | undefined {
  if (fix.status !== 'ready' || !fix.write || fix.write.via === 'georef.site') return undefined;
  const current = facts[editedSourceKey(facts)];
  const writes: GeorefFixWrites = { projectedCRS: [], mapConversion: [] };
  for (const [name, value] of Object.entries(fix.write.input.ProjectedCRS ?? {})) {
    const field = lowerFirst(name);
    if (!(CRS_FIELDS as readonly string[]).includes(field) || typeof value !== 'string') return undefined;
    writes.projectedCRS.push({ field, value, oldValue: current?.crs?.[field as CrsField] });
  }
  for (const [name, value] of Object.entries(fix.write.input.MapConversion ?? {})) {
    const field = lowerFirst(name);
    if (!(CONVERSION_FIELDS as readonly string[]).includes(field) || typeof value !== 'number') return undefined;
    writes.mapConversion.push({ field, value, oldValue: current?.operation?.[field as ConversionField] });
  }
  return writes.projectedCRS.length + writes.mapConversion.length > 0 ? writes : undefined;
}

const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

/** File facts per store: the file does not change under the panel, only the edits laid over it. */
const factsByStore = new WeakMap<IfcDataStore, GeorefFacts | null>();

function factsOf(store: IfcDataStore): GeorefFacts | null {
  let facts = factsByStore.get(store);
  if (facts === undefined) {
    facts = collectGeorefFacts(store);
    factsByStore.set(store, facts);
  }
  return facts;
}

/**
 * Diagnose a model's georeferencing with its unsaved edits, offline (no
 * network: the bundled EPSG index and CRS engine only; what needed more is in
 * `report.skipped`). Null for a model with no STEP source (IFCX, tabular).
 */
export async function diagnoseModelGeoreference(
  store: IfcDataStore,
  edits: GeorefMutationData | undefined,
  mapUnitScale?: number,
): Promise<GeorefDiagnosis | null> {
  const fileFacts = factsOf(store);
  if (!fileFacts) return null;
  const facts = overlayGeorefEdits(fileFacts, edits, mapUnitScale);
  const report = await checkGeorefFacts(facts, {}, facts !== fileFacts);
  const plan = planGeorefFixes(report);
  // The plan lists each finding's fixes in report order, so they are read off in step.
  let cursor = 0;
  const items = report.findings.map((finding): DiagnosisItem => {
    const planned = plan.fixes.slice(cursor, cursor += finding.fixes.length);
    for (const candidate of planned) {
      const writes = fixWrites(candidate, report.facts);
      if (writes) return { finding, fix: { id: candidate.id, summary: candidate.summary, writes } };
    }
    return { finding };
  });
  items.sort((a, b) => SEVERITY_ORDER[a.finding.severity] - SEVERITY_ORDER[b.finding.severity]);

  const outside = items.find((item) => item.finding.code === 'OUTSIDE_CRS_AREA')?.finding.evidence.epsg;
  let outsideAreaOfUse: GeorefDiagnosis['outsideAreaOfUse'];
  if (typeof outside === 'number') {
    try {
      outsideAreaOfUse = await getEpsgAreaOfUse(outside);
    } catch (error) {
      // The warning stands; it says the box could not be loaded rather than omitting it.
      console.warn('[georef check] EPSG area of use unavailable', error);
      outsideAreaOfUse = 'unavailable';
    }
  }
  return { report, items, ...(outsideAreaOfUse ? { outsideAreaOfUse } : {}) };
}
