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
import { getReference } from './attribute-helpers.js';
import type { IfcSourceBytes } from './source-bytes.js';
import {
  composeDerived,
  conversionUnitSymbol,
  currencySymbol,
  measureUnit,
  siUnitSymbolAndScale,
  type MeasureUnit,
} from './project-units-symbols.js';
import { CONVERSION_BASED_UNIT_FACTORS } from './unit-extractor.js';

export type { MeasureUnit };
export { measureUnit };

/** A resolved display unit: the symbol to render plus the factor that converts a
 *  value in this unit to its canonical SI base (`mm` → `1e-3`, `m³/h` → `1/3600`,
 *  `°` → `0.01745…`). `1.0` for SI-base and monetary units. */
export interface ResolvedUnit {
  symbol: string;
  siScale: number;
}

/** Native current point provider; omitted readers retain parsed-source semantics. */
export type UnitEntityReader = (expressId: number) => { type: string; attributes: readonly unknown[] } | null;

/** Expected refusal of a current native context; source-only defaults stay unchanged. */
export class ProjectUnitReadError extends Error {}

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
  /** `null` for a declared unit whose scale could not be resolved (#4690): it
   *  shows no unit rather than the SI default, which would mislabel it. */
  private readonly byType: Map<string, ResolvedUnit | null>;
  private readonly monetaryUnit: ResolvedUnit | null;

  constructor(byType: Map<string, ResolvedUnit | null>, monetary: ResolvedUnit | null) {
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
    const declared = this.byType.get(m.unitType);
    return declared !== undefined ? declared : { symbol: m.defaultSymbol, siScale: 1.0 };
  }

  /** A declared unit whose scale could not be resolved is `undefined` here too. */
  resolvedForUnitType(unitType: string): ResolvedUnit | undefined {
    return this.byType.get(unitType) ?? undefined;
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

/** A {@link UnitEntry} whose type is readable but whose scale is not (#4690). */
interface DeclaredUnit extends Omit<UnitEntry, 'resolved'> {
  resolved: ResolvedUnit | null;
}

/** Resolve a single unit entity by expressId (used for the assignment loop and
 *  for per-property / per-quantity `Unit` overrides). */
export function resolveUnitByRef(
  extractor: EntityExtractor,
  entityIndex: EntityByIdIndexLike,
  ref: number,
  readEntity?: UnitEntityReader,
): UnitEntry | null {
  return resolveUnit(extractor, entityIndex, ref, readEntity, readEntity ? new Set() : undefined);
}

function resolveUnit(extractor: EntityExtractor, entityIndex: EntityByIdIndexLike,
  ref: number, readEntity?: UnitEntityReader, active?: Set<number>): UnitEntry | null {
  // Native current callers also count every dependency read; this path set
  // refuses cycles immediately, before recursion consumes the read budget.
  if (active?.has(ref)) return null;
  active?.add(ref);
  try {
    const entry = resolveDeclaredUnit(extractor, entityIndex, ref, readEntity, active);
    return entry?.resolved ? { ...entry, resolved: entry.resolved } : null;
  } finally {
    active?.delete(ref);
  }
}

function resolveDeclaredUnit(
  extractor: EntityExtractor,
  entityIndex: EntityByIdIndexLike,
  ref: number,
  readEntity?: UnitEntityReader,
  active?: Set<number>,
): DeclaredUnit | null {
  // @raw-entity-enumeration-ok resolve a declared unit from the parsed source index
  const entRef = entityIndex.byId.get(ref);
  const entity = readEntity ? readEntity(ref) : entRef ? extractor.extractEntity(entRef) : null;
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
      // A factor the file does not resolve falls back to the name's known
      // factor, from the linear table the geometry length scale reads, so only
      // for a LENGTHUNIT; anything else is left unresolved rather than guessed
      // at 1.0 (#4690).
      const namedFactor = unitType === 'LENGTHUNIT' ? CONVERSION_BASED_UNIT_FACTORS[name.toUpperCase()] : undefined;
      const scale = (typeof attrs[3] === 'number'
        ? conversionFactorScale(extractor, entityIndex, attrs[3], readEntity)
        : null) ?? (readEntity ? undefined : namedFactor);
      const resolved = scale === undefined ? null : { symbol: conversionUnitSymbol(name), siScale: scale };
      return { unitType, resolved, monetary: false };
    }
    case 'IFCDERIVEDUNIT': {
      // [0]=Elements (list of refs), [1]=UnitType
      const unitType = cleanEnum(attrs[1]);
      const elemRefs = Array.isArray(attrs[0]) ? attrs[0] : [];
      const parts: Array<[string, number]> = [];
      let scale = 1.0;
      let incomplete = false;
      for (const er of elemRefs) {
        const elementRef = readEntity ? getReference(er) : typeof er === 'number' ? er : undefined;
        if (elementRef === undefined) { incomplete = true; continue; }
        const el = resolveDerivedElement(extractor, entityIndex, elementRef, readEntity, active);
        if (el) {
          scale *= Math.pow(el.unitScale, el.exponent);
          parts.push([el.symbol, el.exponent]);
        } else {
          incomplete = true; // a factor we cannot read: the product is not this unit's scale (#4833)
        }
      }
      const symbol = composeDerived(parts);
      if (symbol.length === 0) return null;
      return { unitType, resolved: incomplete ? null : { symbol, siScale: scale }, monetary: false };
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
  readEntity?: UnitEntityReader,
  active?: Set<number>,
): { symbol: string; unitScale: number; exponent: number } | null {
  // @raw-entity-enumeration-ok resolve an element of a parsed derived unit
  const ref = entityIndex.byId.get(elemRef);
  const elem = readEntity ? readEntity(elemRef) : ref ? extractor.extractEntity(ref) : null;
  if (!elem || elem.type.toUpperCase() !== 'IFCDERIVEDUNITELEMENT') return null;
  const attrs = elem.attributes ?? [];
  const unitRef = attrs[0];
  if (typeof unitRef !== 'number') return null;
  const exponent = typeof attrs[1] === 'number' ? Math.trunc(attrs[1]) : 1;
  const entry = resolveUnit(extractor, entityIndex, unitRef, readEntity, active);
  if (!entry) return null;
  return { symbol: entry.resolved.symbol, unitScale: entry.resolved.siScale, exponent };
}

function conversionFactorScale(
  extractor: EntityExtractor,
  entityIndex: EntityByIdIndexLike,
  measureRef: number,
  readEntity?: UnitEntityReader,
): number | null {
  // @raw-entity-enumeration-ok read the source measure in a conversion-based unit
  const ref = entityIndex.byId.get(measureRef);
  const measure = readEntity ? readEntity(measureRef) : ref ? extractor.extractEntity(ref) : null;
  if (!measure || measure.type.toUpperCase() !== 'IFCMEASUREWITHUNIT') return null;
  const attrs = measure.attributes ?? [];
  // [0]=ValueComponent (number or [type, number]), [1]=UnitComponent
  const valueAttr = attrs[0];
  let value: number | undefined;
  if (typeof valueAttr === 'number') value = valueAttr;
  else if (Array.isArray(valueAttr) && valueAttr.length === 2 && typeof valueAttr[1] === 'number') value = valueAttr[1];
  if (value === undefined || !(Number.isFinite(value) && value > 0)) return null;

  // A dangling or unreadable UnitComponent leaves the factor unknown, not SI
  // (#4690). A component that is not an IfcSIUnit is taken at 1.0, as before:
  // the Rust resolver follows it, this reader does not.
  const compRef = attrs[1];
  // @raw-entity-enumeration-ok follow the source unit component reference
  const cRef = typeof compRef === 'number' ? entityIndex.byId.get(compRef) : undefined;
  const comp = readEntity && typeof compRef === 'number' ? readEntity(compRef) : cRef ? extractor.extractEntity(cRef) : null;
  if (!comp) return null;
  if (comp.type.toUpperCase() !== 'IFCSIUNIT') return readEntity ? null : value;
  const cAttrs = comp.attributes ?? [];
  const name = typeof cAttrs[3] === 'string' ? cAttrs[3] : null;
  const prefixAttr = cAttrs[2];
  const prefix = typeof prefixAttr === 'string' && prefixAttr !== '$' ? prefixAttr : null;
  const res = name ? siUnitSymbolAndScale(name, prefix) : null;
  return res ? value * res.scale : null;
}

/**
 * Resolve the file's declared units from `IFCPROJECT → IFCUNITASSIGNMENT`.
 * `projectId` defaults to the file's first IFCPROJECT (pass explicitly,
 * from `resolveOwningIfcProjectId`, for an entity owning a later one).
 * Source-only reads never throw: an absent/malformed assignment yields an
 * empty resolver. An optional current provider refuses unreadable native
 * contexts with ProjectUnitReadError instead of guessing their units.
 */
export function extractProjectUnits(
  source: Uint8Array | IfcSourceBytes,
  entityIndex: EntityIndexLike,
  projectId?: number,
  readEntity?: UnitEntityReader,
): ProjectUnits {
  if (readEntity) {
    const point = readEntity;
    let reads = 0;
    readEntity = id => {
      if (++reads > 512) throw new ProjectUnitReadError('Native project unit dependencies exceed the read limit');
      return point(id);
    };
  }
  const byType = new Map<string, ResolvedUnit | null>();
  let monetary: ResolvedUnit | null = null;

  // @raw-entity-enumeration-ok project units come from the parsed IfcProject, not a live session overlay
  const resolvedId = projectId ?? entityIndex.byType.get('IFCPROJECT')?.[0];
  if (resolvedId === undefined) return new ProjectUnits(byType, monetary);
  // @raw-entity-enumeration-ok dereference the parsed project whose unit assignment is being read
  const projectRef = entityIndex.byId.get(resolvedId);
  if (!projectRef && !readEntity) return new ProjectUnits(byType, monetary);

  const extractor = new EntityExtractor(source);
  const project = readEntity ? readEntity(resolvedId) : extractor.extractEntity(projectRef!);
  if (!project || project.type.toUpperCase() !== 'IFCPROJECT') {
    if (readEntity) throw new ProjectUnitReadError('Native project unit context is unreadable');
    return new ProjectUnits(byType, monetary);
  }

  // IFCPROJECT[8] = UnitsInContext (IFCUNITASSIGNMENT)
  const unitsRef = (project.attributes ?? [])[8];
  if (unitsRef === null) {
    if (readEntity) throw new ProjectUnitReadError('Native project unit context is unset');
    return new ProjectUnits(byType, monetary);
  }
  if (typeof unitsRef !== 'number') {
    if (readEntity) throw new ProjectUnitReadError('Native project unit assignment reference is unreadable');
    return new ProjectUnits(byType, monetary);
  }
  // @raw-entity-enumeration-ok dereference the parsed IfcUnitAssignment from IfcProject
  const assignmentRef = entityIndex.byId.get(unitsRef);
  if (!assignmentRef && !readEntity) return new ProjectUnits(byType, monetary);
  const assignment = readEntity ? readEntity(unitsRef) : extractor.extractEntity(assignmentRef!);
  if (!assignment || assignment.type.toUpperCase() !== 'IFCUNITASSIGNMENT') {
    if (readEntity) throw new ProjectUnitReadError('Native project unit assignment is unreadable');
    return new ProjectUnits(byType, monetary);
  }
  const unitList = (assignment.attributes ?? [])[0];
  if (!Array.isArray(unitList)) {
    if (readEntity) throw new ProjectUnitReadError('Native project unit assignment members are unreadable');
    return new ProjectUnits(byType, monetary);
  }
  if (readEntity && (unitList.length === 0 || unitList.length > 512)) {
    throw new ProjectUnitReadError(unitList.length === 0
      ? 'Native project unit assignment is empty' : 'Native project unit assignment exceeds the read limit');
  }

  for (const ref of unitList) {
    const unitRef = readEntity ? getReference(ref) : typeof ref === 'number' ? ref : undefined;
    if (unitRef === undefined) {
      if (readEntity) throw new ProjectUnitReadError('Native project unit assignment member is unreadable');
      continue;
    }
    const entry = resolveDeclaredUnit(extractor, entityIndex, unitRef, readEntity, readEntity ? new Set() : undefined);
    if (readEntity && (!entry?.resolved || !Number.isFinite(entry.resolved.siScale) || entry.resolved.siScale <= 0)) {
      throw new ProjectUnitReadError('Native project unit is unresolved or unsupported');
    }
    if (!entry) continue;
    if (entry.monetary) {
      monetary ??= entry.resolved;
    } else if (entry.unitType && !byType.has(entry.unitType)) {
      byType.set(entry.unitType, entry.resolved);
    } else if (readEntity && entry.unitType) {
      throw new ProjectUnitReadError('Native project unit assignment repeats a unit type');
    }
  }

  return new ProjectUnits(byType, monetary);
}
