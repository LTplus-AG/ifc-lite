/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  extractLengthUnitScale,
  extractProjectUnits,
  resolveOwningIfcProjectId,
  type IfcDataStore,
} from '@ifc-lite/parser';

/**
 * Per IDS spec, IDS literal values for IFC measure types are always in
 * base SI units. The IFC store keeps the raw author value, so when the
 * project's length unit is `MILLI`, a stored `1000` length means
 * `1.0 metre` and the IDS check `1` should match. This helper applies
 * the project's `lengthUnitScale` to numeric values for length
 * measures, and the analogous area/volume scale to area/volume measures.
 *
 * Properties without a declared dataType (notably `IfcPropertyTableValue`,
 * where columns mix labels and measures) get a conservative double-up:
 * every numeric candidate is surfaced both raw and scaled, so an IDS
 * check using either unit space matches. That double-up only ever uses
 * the length scale — an untyped table has no dataType to key an
 * area/volume exponent off, so it is out of scope here as before.
 */

/**
 * Declared AREAUNIT / VOLUMEUNIT scale for a project, when explicitly
 * present in the file's `IfcUnitAssignment`. IFC does not require these to
 * be derivable from the length unit — a project can declare `LENGTHUNIT`
 * in millimetres and `AREAUNIT` as an explicit square-metre `IFCSIUNIT`
 * (or an `IFCCONVERSIONBASEDUNIT`) with no arithmetic relationship to the
 * length scale. Callers should read this first and fall back to
 * `lengthScale ** 2` / `lengthScale ** 3` only when the corresponding
 * field is `undefined` (no such unit declared).
 */
export interface MeasureScales {
  area?: number;
  volume?: number;
}

const projectUnitsCache = new WeakMap<object, ReturnType<typeof extractProjectUnits>>();

/**
 * Resolve the file-declared area/volume scale for `store`, reusing the
 * canonical `ProjectUnits` resolver (`@ifc-lite/parser`, mirror of
 * `rust/core/src/project_units`) that already backs unit *display* in the
 * viewer and MCP tools (`packages/mcp/src/tools/geometry.ts`,
 * `apps/viewer/src/hooks/zoneFacts.ts`). Memoised per store so repeated
 * property lookups on the same model don't re-walk `IfcUnitAssignment`.
 *
 * `undefined` fields mean "no explicit AREAUNIT/VOLUMEUNIT declared" —
 * the caller is expected to fall back to `lengthScale ** 2` / `** 3`.
 */
export function resolveMeasureScales(store: IfcDataStore): MeasureScales {
  if (!store.source?.length || !store.entityIndex) return {};
  let units = projectUnitsCache.get(store);
  if (!units) {
    units = extractProjectUnits(store.source, store.entityIndex);
    projectUnitsCache.set(store, units);
  }
  return {
    area: units.resolvedForUnitType('AREAUNIT')?.siScale,
    volume: units.resolvedForUnitType('VOLUMEUNIT')?.siScale,
  };
}

/** Per-entity resolved scales: `length` mirrors `store.lengthUnitScale`'s
 *  meaning (metres-per-raw-unit), `area`/`volume` mirror {@link MeasureScales}. */
export interface EntityMeasureScales extends MeasureScales {
  length: number | undefined;
}

const entityProjectScaleCache = new WeakMap<object, Map<number, EntityMeasureScales>>();

/**
 * Resolve length/area/volume scales for `expressId`'s OWN `IFCPROJECT`,
 * not necessarily the file's first one.
 *
 * An ordinary IFC file has exactly one `IFCPROJECT` (EXPRESS invariant), so
 * `store.lengthUnitScale` / {@link resolveMeasureScales} — both resolved
 * once from the file's first `IFCPROJECT` at parse time — are correct for
 * every entity and this is a zero-cost fast path back to them.
 *
 * A multi-project file (the shape `MergedExporter`'s documented `auto`
 * unit-reconciliation mode produces for a federated merge of
 * differently-unit'd models, see issue #1332) can contain a SECOND
 * `IFCPROJECT` with its own, different declared units. An entity belonging
 * to that later project was previously scaled by the FIRST project's units
 * regardless — silently wrong, not absent, and compliance-critical for IDS
 * (a `Width >= 100mm` requirement evaluates against the wrongly-scaled raw
 * value). This resolves the entity's OWN owning project via the shared
 * `resolveOwningIfcProjectId` (`@ifc-lite/parser`'s `owning-project.ts`,
 * also used by `resolveEntityLengthUnitScale` for #3554's material-layer
 * fix — one containment walk, not a per-caller copy) and reads THAT
 * project's units, falling back to the store-wide default when the walk
 * can't place the entity (matches prior behaviour).
 */
export function resolveEntityMeasureScales(
  store: IfcDataStore,
  expressId: number
): EntityMeasureScales {
  const fallback = (): EntityMeasureScales => ({
    length: store.lengthUnitScale,
    ...resolveMeasureScales(store),
  });

  if (!store.source?.length || !store.entityIndex) return fallback();
  const projectIds = store.entityIndex.byType.get('IFCPROJECT') ?? [];
  if (projectIds.length <= 1) return fallback();

  const ownerId = resolveOwningIfcProjectId(store.entityIndex, store.relationships, expressId);
  if (ownerId === undefined) return fallback();

  let byProject = entityProjectScaleCache.get(store);
  if (!byProject) {
    byProject = new Map();
    entityProjectScaleCache.set(store, byProject);
  }
  let scales = byProject.get(ownerId);
  if (!scales) {
    const units = extractProjectUnits(store.source, store.entityIndex, ownerId);
    scales = {
      length: extractLengthUnitScale(store.source, store.entityIndex, ownerId),
      area: units.resolvedForUnitType('AREAUNIT')?.siScale,
      volume: units.resolvedForUnitType('VOLUMEUNIT')?.siScale,
    };
    byProject.set(ownerId, scales);
  }
  return scales;
}

export function applyUnitConversion(
  rawValue: string | number | boolean | null,
  rawValues: string[] | undefined,
  dataType: string | undefined,
  scale: number | undefined,
  measureScales?: MeasureScales
): { value: string | number | boolean | null; values: string[] | undefined } {
  const upper = dataType ? dataType.toUpperCase() : '';
  const isLength =
    upper === 'IFCLENGTHMEASURE' || upper === 'IFCPOSITIVELENGTHMEASURE';
  const isArea = upper === 'IFCAREAMEASURE';
  const isVolume = upper === 'IFCVOLUMEMEASURE';
  const isUntypedTable =
    !dataType && Array.isArray(rawValues) && rawValues.length > 0;

  if (!isLength && !isArea && !isVolume && !isUntypedTable) {
    return { value: rawValue, values: rawValues };
  }

  if (isUntypedTable) {
    if (!scale || scale === 1) {
      return { value: rawValue, values: rawValues };
    }
    const convertNum = (v: unknown): number | null => {
      const n = typeof v === 'number' ? v : parseFloat(String(v));
      return Number.isFinite(n) ? n * scale : null;
    };
    // Untyped table — keep raw values and append scaled copies for every
    // numeric candidate so either unit space matches.
    const expanded: string[] = [];
    for (const v of rawValues!) {
      expanded.push(String(v));
      const c = convertNum(v);
      if (c != null && String(c) !== String(v)) expanded.push(String(c));
    }
    return { value: rawValue, values: expanded };
  }

  // Area scales by the SQUARE of the length factor and volume by the
  // CUBE (a millimetre-authored 1 m² is stored as 1e6 mm², not 1e3) —
  // NOT the raw length scale. Prefer the file's explicitly declared
  // AREAUNIT/VOLUMEUNIT when present; only derive from the length scale
  // when the file declares none (see `resolveMeasureScales` above).
  const effectiveScale = isLength
    ? scale
    : isArea
      ? (measureScales?.area ?? (scale != null ? scale ** 2 : undefined))
      : (measureScales?.volume ?? (scale != null ? scale ** 3 : undefined));

  if (!effectiveScale || effectiveScale === 1) {
    return { value: rawValue, values: rawValues };
  }

  const convertNum = (v: unknown): number | null => {
    const n = typeof v === 'number' ? v : parseFloat(String(v));
    return Number.isFinite(n) ? n * effectiveScale : null;
  };

  const converted = (() => {
    const c = convertNum(rawValue);
    return c == null ? rawValue : c;
  })();
  const values = Array.isArray(rawValues)
    ? rawValues.map((v) => {
        const c = convertNum(v);
        return c == null ? String(v) : String(c);
      })
    : rawValues;
  return { value: converted, values };
}
