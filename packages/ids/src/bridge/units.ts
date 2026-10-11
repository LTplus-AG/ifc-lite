/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  extractLengthUnitScale,
  extractProjectUnits,
  resolveOwningIfcProjectId,
  type IfcDataStore,
  type ProjectUnits,
} from '@ifc-lite/parser';

import {
  convertNumeric,
  convertTypedMembers,
  fromSi,
  isIdentity,
  lengthFamilyKind,
  projectUnitConversion,
  toSi,
  unitConversion,
  type SiConversion,
} from './measure-conversion.js';

/**
 * Per IDS spec, IDS literal values for IFC measure types are always in
 * base SI units. The IFC store keeps the raw author value, so when the
 * project's length unit is `MILLI`, a stored `1000` length means
 * `1.0 metre` and the IDS check `1` should match. This helper applies
 * the project's `lengthUnitScale` to numeric values for length
 * measures, the analogous area/volume scale to area/volume measures, and
 * the declared project unit to every other dimensioned measure (angle,
 * temperature, mass, time, force, power, ...; see measure-conversion.ts).
 *
 * Properties without one shared dataType (an `IfcPropertyTableValue`, where
 * columns mix labels and measures, or a list mixing types) convert each
 * member by its own type when the parser reports it (`valueDataTypes`).
 * Only a source that does not (the prebuilt property table of a
 * server-parsed store) keeps the old conservative double-up: every numeric
 * candidate is surfaced both raw and length-scaled.
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
  /** The project's declared units, for measures outside the length family. */
  units?: ProjectUnits;
  /** File-wide units, for a measure `units` leaves undeclared (a project without its own LENGTHUNIT). */
  fallbackUnits?: ProjectUnits;
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
    units,
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
  // @raw-entity-enumeration-ok enumerate source IfcProject ids to choose the parsed model's unit-resolution path; project units and owning-project relationships are source-snapshot inputs, not live candidate membership
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
    // `extractLengthUnitScale` answers an unconfirmed 1.0 both for "this
    // project declares metres" and "this project declares no LENGTHUNIT at
    // all" - absence reading as success. `UnitsInContext` is OPTIONAL on
    // `IfcContext`, so a federated model CAN arrive with none, and taking the
    // 1.0 would silently rescale a millimetre value by 1000x. `ProjectUnits`
    // tells the two apart, so only a DECLARED length unit overrides the
    // store-wide scale; an undeclared one keeps the file-wide answer, which is
    // the same safe-miss direction the walk-failed fallback already takes.
    const declaresLengthUnit = units.resolvedForUnitType('LENGTHUNIT') !== undefined;
    if (!declaresLengthUnit) {
      // The owner's UnitsInContext is missing or declares no LENGTHUNIT at
      // all, so it has no AREAUNIT/VOLUMEUNIT either (both are read off that
      // same, absent-or-empty assignment). Falling back to
      // store.lengthUnitScale for length ALONE while leaving area/volume
      // undefined would make callers derive area/volume from THIS scale
      // squared/cubed - the file-wide length scale, not the file-wide
      // area/volume scale, which IFC does not require to be related by that
      // exponent (see the module doc above). Take the file-wide answer for
      // all three together, matching the walk-failed fallback exactly.
      // A measure outside the length family still takes the owner's own
      // declared unit (a project may declare grams without a LENGTHUNIT);
      // only one the owner leaves undeclared takes the file-wide unit.
      // An owner's own AREAUNIT/VOLUMEUNIT still wins over the file-wide one.
      const fileWide = fallback();
      scales = {
        ...fileWide,
        area: units.resolvedForUnitType('AREAUNIT')?.siScale ?? fileWide.area,
        volume: units.resolvedForUnitType('VOLUMEUNIT')?.siScale ?? fileWide.volume,
        units,
        fallbackUnits: fileWide.units,
      };
      byProject.set(ownerId, scales);
      return scales;
    }
    // Deliberately re-derives the scale via extractLengthUnitScale rather
    // than reading units.resolvedForUnitType('LENGTHUNIT').siScale: for an
    // IfcConversionBasedUnit the two resolvers can disagree - this one
    // prefers a name-keyed table (e.g. 'FOOT' -> 0.3048) over a non-standard
    // declared ConversionFactor, while ProjectUnits always computes the
    // declared factor (proven, with the disagreeing case, in
    // length-unit-resolvers-agreement.test.ts).
    scales = {
      length: extractLengthUnitScale(store.source, store.entityIndex, ownerId),
      area: units.resolvedForUnitType('AREAUNIT')?.siScale,
      volume: units.resolvedForUnitType('VOLUMEUNIT')?.siScale,
      units,
    };
    byProject.set(ownerId, scales);
  }
  return scales;
}

/**
 * The raw-to-base-SI multiplier for a length-family measure of `dataType`,
 * given the entity's resolved {@link EntityMeasureScales}. Area scales by the
 * SQUARE of the length factor and volume by the CUBE (a millimetre-authored
 * 1 m² is stored as 1e6 mm², not 1e3) — NOT the raw length scale — unless
 * the file declares an explicit AREAUNIT/VOLUMEUNIT, which takes
 * precedence (IFC does not require it to relate to LENGTHUNIT by that
 * exponent; see `resolveMeasureScales` above). `undefined` for a
 * measure outside the length family or when the entity has no resolved
 * length scale.
 */
function lengthFamilyScale(
  dataType: string | undefined,
  scales: EntityMeasureScales
): number | undefined {
  const kind = lengthFamilyKind(dataType);
  if (!kind) return undefined;
  if (kind === 'length') return scales.length;
  if (kind === 'area') {
    return scales.area ?? (scales.length != null ? scales.length ** 2 : undefined);
  }
  return scales.volume ?? (scales.length != null ? scales.length ** 3 : undefined);
}

/**
 * The raw-to-SI conversion for a value of `dataType` held in the project's
 * units: the length family through {@link lengthFamilyScale}, every other
 * dimensioned measure through its declared project unit. The single
 * classification the base projection, an overlay correction and a
 * correction write all key off, so "which measures convert, and how" can't
 * drift between them.
 */
export function measureConversionFor(
  dataType: string | undefined,
  scales: EntityMeasureScales
): SiConversion | undefined {
  const scale = lengthFamilyScale(dataType, scales);
  if (scale !== undefined) return scale ? { scale, offset: 0 } : undefined;
  return projectUnitConversion(dataType, scales.units, scales.fallbackUnits);
}

/**
 * Convert a raw-frame scalar value — the frame every stored IFC property,
 * and every `MutablePropertyView` property mutation, is written in — into
 * the base-SI frame `applyUnitConversion`/`projectProperty` already put
 * every OTHER property of the same pset into. Only numeric measure values
 * move; strings, booleans and non-measure dataTypes pass through
 * unchanged, and a value already in SI is returned as-is.
 */
export function toBaseSI(
  rawValue: string | number | boolean | null,
  dataType: string | undefined,
  scales: EntityMeasureScales
): string | number | boolean | null {
  if (typeof rawValue !== 'number') return rawValue;
  const c = measureConversionFor(dataType, scales);
  return isIdentity(c) ? rawValue : toSi(rawValue, c!);
}

/**
 * The inverse of {@link toBaseSI}: convert a base-SI scalar — an IDS
 * literal, or a user-typed correction meant to satisfy one — into the raw
 * frame the model actually stores. Only numeric measure values move.
 */
export function toRaw(
  baseSIValue: string | number | boolean | null,
  dataType: string | undefined,
  scales: EntityMeasureScales
): string | number | boolean | null {
  if (typeof baseSIValue !== 'number') return baseSIValue;
  const c = measureConversionFor(dataType, scales);
  return isIdentity(c) ? baseSIValue : fromSi(baseSIValue, c!);
}

/**
 * The conversion for a value whose property or quantity declares its OWN
 * `Unit`. `siScale` is the parser's resolved SI factor of that unit
 * (`unitSiScale` / `explicitUnitSiScale`), `symbol` its display symbol and
 * `siOffset` its additive SI offset when it has one (°F, `unitSiOffset`);
 * an unresolved factor, a non-measure dataType or a monetary value (not an
 * SI quantity) gives `undefined`: the value stays as written.
 */
export function ownUnitConversionFor(
  dataType: string | undefined,
  siScale: number | undefined,
  symbol: string | undefined,
  siOffset?: number
): SiConversion | undefined {
  const upper = dataType ? dataType.toUpperCase() : '';
  if (!upper.endsWith('MEASURE') || upper === 'IFCMONETARYMEASURE') return undefined;
  return unitConversion(upper, siScale, symbol, siOffset);
}

/**
 * A list's display value is its members joined by the parser; rebuild it from
 * the converted members so it matches them.
 */
function listDisplayValue(
  rawValue: string | number | boolean | null,
  values: string[]
): string | number | boolean | null {
  return typeof rawValue === 'string' ? values.join(', ') : rawValue;
}

function convertAll(
  rawValue: string | number | boolean | null,
  rawValues: string[] | undefined,
  c: SiConversion | undefined
): { value: string | number | boolean | null; values: string[] | undefined } {
  if (isIdentity(c)) return { value: rawValue, values: rawValues };
  const values = Array.isArray(rawValues)
    ? rawValues.map((m) => {
        const cm = convertNumeric(m, c!);
        return cm == null ? String(m) : String(cm);
      })
    : rawValues;
  if (values && values.length > 1 && typeof rawValue === 'string') {
    return { value: listDisplayValue(rawValue, values), values };
  }
  const v = typeof rawValue === 'boolean' || rawValue === null ? null : convertNumeric(rawValue, c!);
  return { value: v == null ? rawValue : v, values };
}

/**
 * Convert a value whose property or quantity declares its OWN `Unit` into
 * SI. IFC uses that `Unit` precisely to let one value depart from the
 * project's unit assignment, so the project factor must not be applied to
 * it (#7395). A unit that is present but could not be read leaves the value
 * raw rather than silently rescaled by the project factor.
 */
export function applyOwnUnitConversion(
  rawValue: string | number | boolean | null,
  rawValues: string[] | undefined,
  dataType: string | undefined,
  siScale: number | undefined,
  symbol?: string,
  valueDataTypes?: ReadonlyArray<string | undefined>,
  siOffset?: number
): { value: string | number | boolean | null; values: string[] | undefined } {
  // A mixed list has no shared dataType; convert each member by its own type.
  if (!dataType && Array.isArray(rawValues) && rawValues.length > 0 && valueDataTypes?.length === rawValues.length) {
    const values = convertTypedMembers(rawValues, valueDataTypes, (t) => ownUnitConversionFor(t, siScale, symbol, siOffset));
    return { value: listDisplayValue(rawValue, values), values };
  }
  return convertAll(rawValue, rawValues, ownUnitConversionFor(dataType, siScale, symbol, siOffset));
}

/**
 * Convert a value held in the project's units into SI. A multi-valued
 * property without a shared `dataType` converts each member by its own
 * type (`valueDataTypes`, index-aligned with `rawValues`); without those
 * types, see the module doc's legacy double-up.
 */
export function applyUnitConversion(
  rawValue: string | number | boolean | null,
  rawValues: string[] | undefined,
  dataType: string | undefined,
  scale: number | undefined,
  measureScales?: MeasureScales,
  valueDataTypes?: ReadonlyArray<string | undefined>
): { value: string | number | boolean | null; values: string[] | undefined } {
  const scales: EntityMeasureScales = { length: scale, ...measureScales };
  const isUntypedMulti = !dataType && Array.isArray(rawValues) && rawValues.length > 0;

  if (!isUntypedMulti) {
    return convertAll(rawValue, rawValues, measureConversionFor(dataType, scales));
  }

  if (valueDataTypes && valueDataTypes.length === rawValues!.length) {
    const values = convertTypedMembers(rawValues!, valueDataTypes, (t) => measureConversionFor(t, scales));
    return { value: listDisplayValue(rawValue, values), values };
  }

  if (!scale || scale === 1) {
    return { value: rawValue, values: rawValues };
  }
  // Untyped members of unknown type — keep raw values and append
  // length-scaled copies for every numeric candidate so either unit space
  // matches.
  const expanded: string[] = [];
  for (const v of rawValues!) {
    expanded.push(String(v));
    const c = convertNumeric(v, { scale, offset: 0 });
    if (c != null && String(c) !== String(v)) expanded.push(String(c));
  }
  return { value: rawValue, values: expanded };
}
