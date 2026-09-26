/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Classify an IFC measure/type name by its terminal EXPRESS primitive
 * base — STRING / REAL / INTEGER / NUMBER / BOOLEAN / LOGICAL / BINARY —
 * via the codegen-generated per-schema-version type registry in
 * `@ifc-lite/parser`, following chained `TYPE` definitions (e.g.
 * `IfcPositiveInteger -> IfcInteger -> INTEGER`).
 *
 * Exists because the property facet's string-only decision (#6117) must
 * key off the EXPRESS base, not an XSD backing-type name: `IfcDate`,
 * `IfcDateTime` and `IfcDuration` back onto `xs:date`/`xs:dateTime`/
 * `xs:duration` while remaining EXPRESS STRING underneath, so the earlier
 * "does it map to exactly one XSD type named xs:string" heuristic let
 * numeric coercion stay on for them (review of #6153).
 */

import { getSchemaRegistryForVersion, type SchemaVersionWithRegistry } from '@ifc-lite/parser';

const TYPE_BASE_CACHE = new Map<SchemaVersionWithRegistry, Map<string, string>>();

function typeBasesFor(version: SchemaVersionWithRegistry): Map<string, string> {
  let m = TYPE_BASE_CACHE.get(version);
  if (!m) {
    m = new Map();
    for (const [name, underlying] of Object.entries(getSchemaRegistryForVersion(version).types)) {
      m.set(name.toUpperCase(), underlying);
    }
    TYPE_BASE_CACHE.set(version, m);
  }
  return m;
}

/** IFC2X3/IFC4X3 explicitly; every other spelling (undefined, "IFC4",
 *  a variant suffix) defaults to the IFC4 registry — the measures this
 *  resolves (dates, durations, labels, numeric measures) are stable
 *  across the three bundled schemas. */
function resolveVersion(schemaVersion: string | undefined): SchemaVersionWithRegistry {
  const v = schemaVersion?.toUpperCase();
  return v === 'IFC2X3' || v === 'IFC4X3' ? v : 'IFC4';
}

const PRIMITIVE_BASE = /^(STRING|REAL|INTEGER|NUMBER|BOOLEAN|LOGICAL|BINARY)\b/;

/**
 * True iff `measure`'s EXPRESS base must never be numeric/boolean
 * coerced: STRING, an unresolved/unknown name, or (defensively) an
 * aggregate — an IDS property scalar value is never a LIST/SET/ARRAY, so
 * treating that shape as string-only costs nothing. Only a base that
 * resolves cleanly to REAL/INTEGER/NUMBER/BOOLEAN/LOGICAL returns false.
 */
export function isExpressStringOnlyMeasure(measure: string, schemaVersion?: string): boolean {
  const bases = typeBasesFor(resolveVersion(schemaVersion));
  let current = measure.toUpperCase();
  // Bounded: a chain longer than the deepest real defined-type nesting
  // (observed max 2) would mean a cycle or a codegen anomaly, not a
  // legitimate schema — fail safe (string-only) rather than loop.
  for (let i = 0; i < 8; i++) {
    const underlying = bases.get(current);
    if (underlying === undefined) return true;
    const primitive = PRIMITIVE_BASE.exec(underlying)?.[1];
    if (primitive) {
      return primitive !== 'REAL' && primitive !== 'INTEGER' && primitive !== 'NUMBER' &&
        primitive !== 'BOOLEAN' && primitive !== 'LOGICAL';
    }
    current = underlying.toUpperCase(); // chained defined type — follow it
  }
  return true;
}
