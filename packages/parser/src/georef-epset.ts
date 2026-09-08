/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The IFC2x3 property-set georeferencing path.
 *
 * IFC2x3 has no `IfcMapConversion`, so buildingSMART's geo-referencing guide
 * puts the same six numbers in a property set named `ePSet_MapConversion`,
 * paired with an `ePSet_ProjectedCRS` for the CRS metadata. This file reads
 * that pair; `georef-map-conversion.ts` reads the IFC4 entity. The two are
 * twins and must stay in step — most of all in what they REFUSE, which is why
 * the property list below is written against that file's slot list.
 *
 * Split out of `georef-extractor.ts` for the same reason the entity reader
 * was: that file is at its module-size budget, and this is the half of it a
 * schema revision keeps touching.
 */

import type { IfcEntity } from './entity-extractor.js';
import type { GeoreferenceInfo, MapConversion, ProjectedCRS } from './georef-extractor.js';
import { computeTransformMatrix } from './georef-transform.js';
import {
  getString,
  getNumber,
  getReference,
  isUnrepresentableNumericValue,
} from './attribute-helpers.js';
import { inferMapUnitScaleFromLabel } from './map-unit-label.js';


/**
 * Unwrap an IfcValue `NominalValue`. The columnar/on-demand extractor delivers
 * typed values as a `[TYPENAME, value]` tuple (e.g.
 * `["IFCLENGTHMEASURE", 160073528]`, `["IFCLABEL", "EPSG:7415"]`), which
 * `getNumber`/`getString` don't see through; raw scalars (used by the
 * entity-map callers) pass through untouched.
 */
function unwrapNominalValue(value: unknown): unknown {
  if (Array.isArray(value) && value.length >= 2 && typeof value[0] === 'string') {
    return value[1];
  }
  return value;
}

/**
 * Read an `IfcPropertySet`'s `IfcPropertySingleValue` children into a
 * name → raw-value map, keeping the value as-is (string or number) so both
 * numeric (Eastings) and string (TargetCRS, EPSG Name) properties survive.
 */
function readPsetSingleValues(
  entities: Map<number, IfcEntity>,
  pset: IfcEntity,
): Record<string, string | number> {
  const values: Record<string, string | number> = {};
  // IfcPropertySet: GlobalId (0), OwnerHistory (1), Name (2), Description (3), HasProperties (4)
  const props = pset.attributes[4];
  if (Array.isArray(props)) {
    for (const propRef of props) {
      const propId = getReference(propRef);
      if (!propId) continue;
      const prop = entities.get(propId);
      if (!prop) continue;
      // IfcPropertySingleValue: Name (0), Description (1), NominalValue (2)
      const propName = getString(prop.attributes[0]);
      if (!propName) continue;
      const raw = unwrapNominalValue(prop.attributes[2]);
      if (typeof raw === 'number') {
        values[propName] = raw;
      } else if (typeof raw === 'string') {
        // Keep the raw string verbatim. Coordinate fields are coerced on read
        // via `asNumber` (some writers store Eastings/Scale as strings), while
        // CRS metadata that merely looks numeric — `Name: "7415"`, `MapZone:
        // "31N"` — must stay a string so `asString` doesn't discard it.
        values[propName] = raw;
      }
    }
  }
  return values;
}

/**
 * Find the first `IfcPropertySet` whose Name matches `targetName`
 * case-insensitively. buildingSMART's geo-referencing guide spells the
 * IFC2x3 property sets `ePSet_…` (capital S), but real authoring tools (e.g.
 * the `ifc-georeferencer` post-processor) write `ePset_…` (lowercase) — an
 * exact match silently dropped those models to the legacy IfcSite/EPSG:4326
 * fallback, so they displayed the wrong CRS.
 */
function findPsetByName(
  entities: Map<number, IfcEntity>,
  entitiesByType: Map<string, number[]>,
  targetName: string,
): IfcEntity | null {
  const target = targetName.toLowerCase();
  const psetIds = entitiesByType.get('IfcPropertySet') || [];
  for (const psetId of psetIds) {
    const pset = entities.get(psetId);
    if (!pset) continue;
    const name = getString(pset.attributes[2]);
    if (name && name.toLowerCase() === target) return pset;
  }
  return null;
}

function asString(value: string | number | undefined): string | undefined {
  if (typeof value === 'string') return value.length > 0 ? value : undefined;
  if (typeof value === 'number') return String(value);
  return undefined;
}

/**
 * Delegates outright rather than short-circuiting an already-`number` value.
 *
 * It used to read `typeof value === 'number' ? value : getNumber(value)`,
 * which is the same hole `getNumber` itself was just closed for: `Infinity`
 * and `NaN` are `typeof 'number'`, so the short circuit handed them straight
 * back and this helper's contract read "finite, unless the pset already held
 * a number". `getNumber`'s number branch now returns the value when finite and
 * `undefined` otherwise, which is what the short circuit was approximating —
 * so there is nothing left for it to save, and one guard is easier to keep
 * true than two.
 */
function asNumber(value: string | number | undefined): number | undefined {
  return getNumber(value);
}

/**
 * The ePSet placement components, mirroring `TRANSFORM_NUMERIC_SLOTS` in
 * `georef-map-conversion.ts` — the IFC2x3 property-set spelling of the same
 * six `IfcMapConversion` attributes, read by name instead of by slot.
 */
const EPSET_TRANSFORM_PROPERTIES: readonly string[] = [
  'Eastings',
  'Northings',
  'OrthogonalHeight',
  'XAxisAbscissa',
  'XAxisOrdinate',
  'Scale',
];

/**
 * IFC2x3 fallback: a property set named `ePSet_MapConversion` (any casing)
 * carrying Eastings/Northings/OrthogonalHeight (+ optional
 * XAxisAbscissa/XAxisOrdinate/Scale/TargetCRS), optionally paired with an
 * `ePSet_ProjectedCRS` set carrying the EPSG `Name`. Mirrors
 * `GeoRefExtractor::extract_from_pset` in rust/core/src/georef.rs.
 */
export function extractEPSetMapConversion(
  entities: Map<number, IfcEntity>,
  entitiesByType: Map<string, number[]>,
): GeoreferenceInfo | null {
  const pset = findPsetByName(entities, entitiesByType, 'ePSet_MapConversion');
  if (!pset) return null;

  const values = readPsetSingleValues(entities, pset);

  // The IFC2x3 twin of the refusal in `georef-map-conversion.ts`, and it has
  // to be here rather than there because this path never builds an
  // `IfcMapConversion` entity to hand over. The two are the same fix: a
  // placement component the double range cannot hold refuses the placement
  // instead of substituting a plausible number for it.
  //
  // Without this the `?? 0` below put a `0` easting into a `MapConversion`
  // that still claimed `hasGeoreference: true`, with no diagnostic — the
  // model silently placed at the projection origin. That is the exact failure
  // the native path was changed to stop, and it was reachable here the moment
  // `getNumber` began answering `undefined` for an overflowing literal
  // (before that it answered `Infinity`, which is not nullish, so `?? 0` never
  // fired and the poison at least stayed visible).
  const refusedProperty = EPSET_TRANSFORM_PROPERTIES.find((name) =>
    isUnrepresentableNumericValue(values[name]),
  );

  // Resolve the CRS name from ePSet_ProjectedCRS.Name, falling back to the
  // MapConversion's TargetCRS (the ifc-georeferencer tool writes both as the
  // same EPSG label). Without this the EPSG code in the file was never
  // surfaced on the IFC2x3 path.
  const crsPset = findPsetByName(entities, entitiesByType, 'ePSet_ProjectedCRS');
  const crsValues = crsPset ? readPsetSingleValues(entities, crsPset) : {};
  const crsName = asString(crsValues['Name']) ?? asString(values['TargetCRS']);

  if (refusedProperty !== undefined) {
    console.warn(
      `[georef-extractor] ePSet_MapConversion #${pset.expressId} ${refusedProperty} is ` +
      `outside the IEEE-754 double range (${String(values[refusedProperty])}); refusing the ` +
      `map conversion rather than placing the model at a substituted origin.`,
    );
  }

  // Some writers store the offsets as strings, so coerce on read.
  const eastings = asNumber(values['Eastings']) ?? 0;
  const northings = asNumber(values['Northings']) ?? 0;
  const orthogonalHeight = asNumber(values['OrthogonalHeight']) ?? 0;

  // Reject only when there is nothing to georeference by: no CRS name AND the
  // placement sits at the local origin. Mirrors `has_georef()` in rust/core
  // (a CRS name OR any non-zero offset is sufficient) so a valid zero-origin
  // placement at a real projected CRS is kept rather than dropping to the
  // legacy IfcSite/EPSG:4326 fallback.
  //
  // A refused placement takes this branch too when the file names no CRS —
  // there is genuinely nothing left to report — and the caller then falls
  // through to the legacy IfcSite/EPSG:4326 path. That fallback is no longer
  // silent: the refusal above has already said why the ePSet was discarded.
  if (!crsName && (refusedProperty !== undefined
    || (eastings === 0 && northings === 0 && orthogonalHeight === 0))) {
    return null;
  }

  let projectedCRS: ProjectedCRS | undefined;
  if (crsName || crsPset) {
    const mapUnit = asString(crsValues['MapUnit']);
    projectedCRS = {
      id: crsPset?.expressId ?? pset.expressId,
      name: crsName ?? '',
      description: asString(crsValues['Description']),
      geodeticDatum: asString(crsValues['GeodeticDatum']),
      verticalDatum: asString(crsValues['VerticalDatum']),
      mapProjection: asString(crsValues['MapProjection']),
      mapZone: asString(crsValues['MapZone']),
      mapUnit,
      // An explicit ePSet MapUnit carries its own scale (parity with the native
      // IfcProjectedCRS path). When absent, leave it undefined so consumers fall
      // back to the project length unit per the buildingSMART convention.
      mapUnitScale: inferMapUnitScaleFromLabel(mapUnit),
    };
  }

  if (refusedProperty !== undefined) {
    // Parity with the native path, where a refused conversion leaves
    // `mapConversion` and `transformMatrix` absent while an `IfcProjectedCRS`
    // still claims `hasGeoreference` — the file does declare a CRS, it just
    // carries no usable placement. `source` stays absent for the same reason
    // it does there: it names where the *placement* came from, and there is
    // none.
    return { hasGeoreference: true, projectedCRS };
  }

  const mapConversion: MapConversion = {
    id: pset.expressId,
    sourceCRS: 0,
    targetCRS: 0,
    eastings,
    northings,
    orthogonalHeight,
    xAxisAbscissa: asNumber(values['XAxisAbscissa']),
    xAxisOrdinate: asNumber(values['XAxisOrdinate']),
    scale: asNumber(values['Scale']),
  };

  return {
    hasGeoreference: true,
    source: 'ePSetMapConversion',
    mapConversion,
    projectedCRS,
    transformMatrix: computeTransformMatrix(mapConversion),
  };
}
