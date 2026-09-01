/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Canonical resolution of a file's declared units for DISPLAY.
 *
 * This is the TypeScript mirror of the Rust source of truth in
 * `rust/core/src/project_units/`. Where {@link extractLengthUnitScale} resolves
 * only the LENGTH scale needed for geometry, this resolves the whole
 * `IfcUnitAssignment` into per-unit-type display symbols + SI scale factors,
 * covering `IfcSIUnit` (with prefixes), `IfcDerivedUnit` (composed, e.g. `m³/s`),
 * `IfcConversionBasedUnit` (°, ft, ...) and `IfcMonetaryUnit`, and maps a
 * property's IFC measure value type onto the unit it is shown in (issue #1573).
 *
 * The two implementations are pinned to the shared parity vectors in
 * `rust/core/tests/fixtures/unit_symbol_vectors.json`
 * (`packages/parser/src/project-units.parity.test.ts`), so they cannot drift.
 */

import type { EntityRef } from './types.js';
import { EntityExtractor } from './entity-extractor.js';
import type { IfcSourceBytes } from './source-bytes.js';
import {
  composeDerived,
  conversionUnitSymbol,
  currencySymbol,
  measureUnit,
  siUnitSymbolAndScale,
  type MeasureUnit,
} from './project-units-symbols.js';

export type { MeasureUnit };
export { measureUnit };

/** A resolved display unit: the symbol to render plus the factor that converts a
 *  value in this unit to its canonical SI base (`mm` → `1e-3`, `m³/h` → `1/3600`,
 *  `°` → `0.01745…`). `1.0` for SI-base and monetary units. */
export interface ResolvedUnit {
  symbol: string;
  siScale: number;
}

interface EntityByIdIndexLike {
  byId: { get(expressId: number): EntityRef | undefined };
}

interface EntityIndexLike extends EntityByIdIndexLike {
  byType: Map<string, number[]>;
}

// ============================================================================
// Unit-assignment resolution (mirror project_units/mod.rs)
// ============================================================================

/** The file's declared units, keyed by unit-type token. */
export class ProjectUnits {
  private readonly byType: Map<string, ResolvedUnit>;
  private readonly monetaryUnit: ResolvedUnit | null;

  constructor(byType: Map<string, ResolvedUnit>, monetary: ResolvedUnit | null) {
    this.byType = byType;
    this.monetaryUnit = monetary;
  }

  static empty(): ProjectUnits {
    return new ProjectUnits(new Map(), null);
  }

  /** The display unit for a property/quantity with IFC measure type
   *  `measureType`. Prefers the file's declared unit and falls back to the
   *  IFC-canonical SI default. `null` for dimensionless / non-measure types. */
  unitForMeasure(measureType: string): ResolvedUnit | null {
    const m = measureUnit(measureType);
    if (!m) return null;
    if (m.kind === 'dimensionless') return null;
    if (m.kind === 'monetary') return this.monetaryUnit;
    return this.byType.get(m.unitType) ?? { symbol: m.defaultSymbol, siScale: 1.0 };
  }

  resolvedForUnitType(unitType: string): ResolvedUnit | undefined {
    return this.byType.get(unitType);
  }

  monetary(): ResolvedUnit | null {
    return this.monetaryUnit;
  }

  get declaredCount(): number {
    return this.byType.size;
  }
}

interface UnitEntry {
  unitType: string | null;
  resolved: ResolvedUnit;
  monetary: boolean;
}

/** Resolve a single unit entity by expressId (used for the assignment loop and
 *  for per-property / per-quantity `Unit` overrides). */
export function resolveUnitByRef(
  extractor: EntityExtractor,
  entityIndex: EntityByIdIndexLike,
  ref: number,
): UnitEntry | null {
  const entRef = entityIndex.byId.get(ref);
  if (!entRef) return null;
  const entity = extractor.extractEntity(entRef);
  if (!entity) return null;
  const attrs = entity.attributes ?? [];
  const cleanEnum = (v: unknown): string | null =>
    typeof v === 'string' ? v.replace(/\./g, '').trim().toUpperCase() : null;

  switch (entity.type.toUpperCase()) {
    case 'IFCSIUNIT': {
      // [1]=UnitType, [2]=Prefix, [3]=Name
      const unitType = cleanEnum(attrs[1]);
      const name = typeof attrs[3] === 'string' ? attrs[3] : null;
      if (!name) return null;
      const prefixAttr = attrs[2];
      const prefix = typeof prefixAttr === 'string' && prefixAttr !== '$' ? prefixAttr : null;
      const res = siUnitSymbolAndScale(name, prefix);
      if (!res) return null;
      return { unitType, resolved: { symbol: res.symbol, siScale: res.scale }, monetary: false };
    }
    case 'IFCCONVERSIONBASEDUNIT': {
      // [1]=UnitType, [2]=Name, [3]=ConversionFactor
      const unitType = cleanEnum(attrs[1]);
      const name = typeof attrs[2] === 'string' ? attrs[2] : '';
      const symbol = conversionUnitSymbol(name);
      const scale = typeof attrs[3] === 'number'
        ? conversionFactorScale(extractor, entityIndex, attrs[3]) ?? 1.0
        : 1.0;
      return { unitType, resolved: { symbol, siScale: scale }, monetary: false };
    }
    case 'IFCDERIVEDUNIT': {
      // [0]=Elements (list of refs), [1]=UnitType
      const unitType = cleanEnum(attrs[1]);
      const elemRefs = Array.isArray(attrs[0]) ? attrs[0] : [];
      const parts: Array<[string, number]> = [];
      let scale = 1.0;
      for (const er of elemRefs) {
        if (typeof er !== 'number') continue;
        const el = resolveDerivedElement(extractor, entityIndex, er);
        if (el) {
          scale *= Math.pow(el.unitScale, el.exponent);
          parts.push([el.symbol, el.exponent]);
        }
      }
      const symbol = composeDerived(parts);
      if (symbol.length === 0) return null;
      return { unitType, resolved: { symbol, siScale: scale }, monetary: false };
    }
    case 'IFCMONETARYUNIT': {
      // [0]=Currency (IfcLabel string in IFC4+, IfcCurrencyEnum in IFC2x3)
      const currency = typeof attrs[0] === 'string' ? attrs[0] : '';
      return { unitType: null, resolved: { symbol: currencySymbol(currency), siScale: 1.0 }, monetary: true };
    }
    default:
      return null;
  }
}

function resolveDerivedElement(
  extractor: EntityExtractor,
  entityIndex: EntityByIdIndexLike,
  elemRef: number,
): { symbol: string; unitScale: number; exponent: number } | null {
  const ref = entityIndex.byId.get(elemRef);
  if (!ref) return null;
  const elem = extractor.extractEntity(ref);
  if (!elem || elem.type.toUpperCase() !== 'IFCDERIVEDUNITELEMENT') return null;
  const attrs = elem.attributes ?? [];
  const unitRef = attrs[0];
  if (typeof unitRef !== 'number') return null;
  const exponent = typeof attrs[1] === 'number' ? Math.trunc(attrs[1]) : 1;
  const entry = resolveUnitByRef(extractor, entityIndex, unitRef);
  if (!entry) return null;
  return { symbol: entry.resolved.symbol, unitScale: entry.resolved.siScale, exponent };
}

function conversionFactorScale(
  extractor: EntityExtractor,
  entityIndex: EntityByIdIndexLike,
  measureRef: number,
): number | null {
  const ref = entityIndex.byId.get(measureRef);
  if (!ref) return null;
  const measure = extractor.extractEntity(ref);
  if (!measure || measure.type.toUpperCase() !== 'IFCMEASUREWITHUNIT') return null;
  const attrs = measure.attributes ?? [];
  // [0]=ValueComponent (number or [type, number]), [1]=UnitComponent
  const valueAttr = attrs[0];
  let value: number | undefined;
  if (typeof valueAttr === 'number') value = valueAttr;
  else if (Array.isArray(valueAttr) && valueAttr.length === 2 && typeof valueAttr[1] === 'number') value = valueAttr[1];
  if (value === undefined || !(Number.isFinite(value) && value > 0)) return null;

  let componentScale = 1.0;
  const compRef = attrs[1];
  if (typeof compRef === 'number') {
    const cRef = entityIndex.byId.get(compRef);
    if (cRef) {
      const comp = extractor.extractEntity(cRef);
      if (comp && comp.type.toUpperCase() === 'IFCSIUNIT') {
        const cAttrs = comp.attributes ?? [];
        const name = typeof cAttrs[3] === 'string' ? cAttrs[3] : null;
        const prefixAttr = cAttrs[2];
        const prefix = typeof prefixAttr === 'string' && prefixAttr !== '$' ? prefixAttr : null;
        if (name) {
          const res = siUnitSymbolAndScale(name, prefix);
          if (res) componentScale = res.scale;
        }
      }
    }
  }
  return value * componentScale;
}

/**
 * Resolve the file's declared units from `IFCPROJECT → IFCUNITASSIGNMENT`.
 * Never throws: an absent/malformed assignment yields an empty {@link ProjectUnits}
 * (all measures then fall back to their SI default symbols).
 */
export function extractProjectUnits(
  source: Uint8Array | IfcSourceBytes,
  entityIndex: EntityIndexLike,
): ProjectUnits {
  const byType = new Map<string, ResolvedUnit>();
  let monetary: ResolvedUnit | null = null;

  const projectIds = entityIndex.byType.get('IFCPROJECT') ?? [];
  if (projectIds.length === 0) return new ProjectUnits(byType, monetary);
  const projectRef = entityIndex.byId.get(projectIds[0]);
  if (!projectRef) return new ProjectUnits(byType, monetary);

  const extractor = new EntityExtractor(source);
  const project = extractor.extractEntity(projectRef);
  if (!project) return new ProjectUnits(byType, monetary);

  // IFCPROJECT[8] = UnitsInContext (IFCUNITASSIGNMENT)
  const unitsRef = (project.attributes ?? [])[8];
  if (typeof unitsRef !== 'number') return new ProjectUnits(byType, monetary);
  const assignmentRef = entityIndex.byId.get(unitsRef);
  if (!assignmentRef) return new ProjectUnits(byType, monetary);
  const assignment = extractor.extractEntity(assignmentRef);
  if (!assignment || assignment.type.toUpperCase() !== 'IFCUNITASSIGNMENT') {
    return new ProjectUnits(byType, monetary);
  }
  const unitList = (assignment.attributes ?? [])[0];
  if (!Array.isArray(unitList)) return new ProjectUnits(byType, monetary);

  for (const ref of unitList) {
    if (typeof ref !== 'number') continue;
    const entry = resolveUnitByRef(extractor, entityIndex, ref);
    if (!entry) continue;
    if (entry.monetary) {
      monetary ??= entry.resolved;
    } else if (entry.unitType && !byType.has(entry.unitType)) {
      byType.set(entry.unitType, entry.resolved);
    }
  }

  return new ProjectUnits(byType, monetary);
}
