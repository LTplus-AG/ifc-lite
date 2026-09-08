/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Single per-column unit resolution shared by the Lists on-screen table and
 * its export (issue #1573 follow-up). Given the columns (with
 * `quantityType`/`dataType` populated by `executeList`), the per-model
 * declared units, and the user's display-unit overrides, this picks ONE
 * target unit per convertible column and converts every row into it -
 * single-target normalization, not "convert each row into its own model's
 * unit" - so a summed / federated column is correct-by-construction (a sum
 * across mixed-unit models is meaningless otherwise) and the on-screen table
 * and the export can never disagree, because both call this resolver.
 */

import type { CellValue, ColumnDefinition } from '@ifc-lite/lists';
import { measureUnit, type ProjectUnits } from '@ifc-lite/parser';
import { alternativesForUnitType } from './alternatives.js';
import { convertValue, resolveFromUnit, type LinearUnit } from './convert.js';
import { QUANTITY_TYPE_UNIT } from './display.js';

/** The unit-KIND a column resolves to: the unit-type token used to look up
 *  declared units / overrides, plus the SI default symbol to fall back to
 *  when no model declares it. */
interface ColumnUnitKind {
  unitType: string;
  defaultSymbol: string;
}

/** `undefined` for a column with no unit semantics (not a quantity, and not
 *  a typed measure property) - i.e. non-convertible. */
function columnUnitKind(col: ColumnDefinition): ColumnUnitKind | undefined {
  if (col.quantityType !== undefined) {
    const entry = QUANTITY_TYPE_UNIT[col.quantityType];
    return entry ? { unitType: entry.unitType, defaultSymbol: entry.defaultSymbol } : undefined;
  }
  if (col.dataType) {
    const m = measureUnit(col.dataType);
    if (m?.kind === 'typed') return { unitType: m.unitType, defaultSymbol: m.defaultSymbol };
  }
  return undefined;
}

/** IFC lets a project declare no explicit `AREAUNIT`/`VOLUMEUNIT` at all —
 *  the file then means "derive it from `LENGTHUNIT`", squared for area and
 *  cubed for volume (a millimetre-authored 1 m² is stored raw as `1e6`, not
 *  `1e3`). Same fallback `quantitySiScale` (`@ifc-lite/parser`) and IDS's
 *  `resolveMeasureScales` already implement; kept in sync by
 *  `AREA_VOLUME_POWER`'s two entries rather than a general power lookup. */
const AREA_VOLUME_POWER: Record<string, number> = { AREAUNIT: 2, VOLUMEUNIT: 3 };

/**
 * A model's SOURCE unit for `kind.unitType`, as a `LinearUnit`: its explicit
 * declaration (through {@link resolveFromUnit}, so a curated affine unit like
 * DEGREE_CELSIUS keeps its offset) when present, else — for AREAUNIT/VOLUMEUNIT
 * only — the length unit's scale raised to the matching power. `undefined`
 * when the model declares neither.
 *
 * The length-derived branch is built directly as `{scale, offset: 0}`
 * rather than round-tripped through `resolveFromUnit` (unlike the declared
 * branch): area/volume units are never affine, and `resolveFromUnit` picks a
 * curated alternative by SYMBOL — `kind.defaultSymbol` ('m²'/'m³') collides
 * with the real SI m²/m³ alternative (scale 1), which would silently discard
 * the derived scale and read every row as already-SI. Not to be used for the
 * TARGET side: `resolveTarget` intentionally treats "no model declares this
 * unit-type" as "fall to the SI default", not "adopt the first model's
 * implied unit" — the target is one fixed unit for the whole column, and its
 * own SI-default branch already gives it a well-defined scale of 1.
 */
function sourceUnitFor(pu: ProjectUnits, kind: ColumnUnitKind): (LinearUnit & { symbol: string }) | undefined {
  const declared = pu.resolvedForUnitType(kind.unitType);
  if (declared) {
    const lin = resolveFromUnit(kind.unitType, declared);
    return { scale: lin.scale, offset: lin.offset, symbol: declared.symbol };
  }
  const power = AREA_VOLUME_POWER[kind.unitType];
  if (power === undefined) return undefined;
  const length = pu.unitForMeasure('IfcLengthMeasure');
  if (!length) return undefined;
  return { scale: length.siScale ** power, offset: 0, symbol: kind.defaultSymbol };
}

interface TargetUnit extends LinearUnit {
  symbol: string;
}

/** Resolves ONE target unit per column and converts raw cell values (given
 *  their owning row's modelId) into it. */
export interface ListColumnUnitResolver {
  /** The column's target display symbol, or `null` when it isn't
   *  convertible (no quantity/measure unit semantics). */
  unitSymbol(colIndex: number): string | null;
  /** Convert `rawValue` (as declared by model `modelId`) into the column's
   *  target unit. Passes through unchanged - never throws - for a
   *  non-convertible column, a non-finite/non-numeric value, or an
   *  unrecognized `modelId` (its source unit can't be resolved safely). */
  convertCell(colIndex: number, rawValue: CellValue, modelId: string): CellValue;
}

/**
 * Build the shared resolver. `modelUnits` insertion order determines
 * "first-contributing" (the model whose declared unit becomes the target)
 * when no override picks the target explicitly.
 */
export function resolveListColumnUnits(
  columns: ColumnDefinition[],
  modelUnits: Map<string, ProjectUnits>,
  overrides: Record<string, string>,
): ListColumnUnitResolver {
  const kinds = columns.map(columnUnitKind);
  const targets = kinds.map((kind) => (kind ? resolveTarget(kind, modelUnits, overrides) : undefined));

  return {
    unitSymbol(colIndex) {
      return targets[colIndex]?.symbol ?? null;
    },
    convertCell(colIndex, rawValue, modelId) {
      const kind = kinds[colIndex];
      const target = targets[colIndex];
      if (!kind || !target) return rawValue;
      if (typeof rawValue !== 'number' || !Number.isFinite(rawValue)) return rawValue;
      const pu = modelUnits.get(modelId);
      if (!pu) return rawValue; // unrecognized model — can't resolve its source unit safely
      const from: LinearUnit = sourceUnitFor(pu, kind) ?? resolveFromUnit(kind.unitType, { symbol: kind.defaultSymbol, siScale: 1 });
      // Identity short-circuit: when the row's declared unit already equals the
      // target (single model, no override — the common case), skip the round
      // trip. `v * s / s` is NOT an FP identity for non-power-of-two scales
      // (877 in a foot file would become 876.9999999999999 and leak into the
      // raw-number XLSX export), and it also sidesteps any offset asymmetry.
      if (from.scale === target.scale && (from.offset ?? 0) === (target.offset ?? 0)) return rawValue;
      return convertValue(rawValue, from, target);
    },
  };
}

/** Pick the target unit for a column: the override when it names a valid
 *  curated alternative, else the first model (in `modelUnits` insertion
 *  order) that declares this unit-type, else the measure's SI default. */
function resolveTarget(
  kind: ColumnUnitKind,
  modelUnits: Map<string, ProjectUnits>,
  overrides: Record<string, string>,
): TargetUnit {
  const overrideId = overrides[kind.unitType];
  if (overrideId) {
    const option = alternativesForUnitType(kind.unitType).find((o) => o.id === overrideId);
    if (option) return { scale: option.scale, offset: option.offset, symbol: option.symbol };
  }
  // Resolve the target through `resolveFromUnit` too, so the source and target
  // sides of the SAME declared unit are computed symmetrically. `ResolvedUnit`
  // carries only a scale, but `resolveFromUnit` recovers a curated unit's affine
  // offset by symbol (e.g. a file declaring DEGREE_CELSIUS): building the target
  // as `{offset: 0}` while the source recovers `+273.15` would shift every
  // temperature by 273.15 with no override set.
  for (const pu of modelUnits.values()) {
    const declared = pu.resolvedForUnitType(kind.unitType);
    if (declared) {
      const lin = resolveFromUnit(kind.unitType, declared);
      return { scale: lin.scale, offset: lin.offset, symbol: declared.symbol };
    }
  }
  const def = resolveFromUnit(kind.unitType, { symbol: kind.defaultSymbol, siScale: 1 });
  return { scale: def.scale, offset: def.offset, symbol: kind.defaultSymbol };
}
