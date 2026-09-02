/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pure aggregation helpers for `ifc-lite stats` — extracted so the KPI /
 * WWR / GFA math can be unit tested against a fake `bim` surface instead of
 * only through a real parsed IFC file. `statsCommand` in stats.ts wires
 * these to the SDK's `BimContext`.
 */

import { findPropertyInSets } from '@ifc-lite/query';
import { firstNonBlank, isBlank } from '../output.js';

export interface QuantitySet {
  name: string;
  quantities: Array<{ name: string; value: unknown }>;
}

export interface PropertySet {
  name: string;
  properties?: Array<{ name: string; value: unknown }>;
}

/** Minimal surface these helpers need from a `BimContext`. */
export interface QuantityBim<R = unknown> {
  quantities: (ref: R) => QuantitySet[];
}

export interface PropertyBim<R = unknown> {
  properties: (ref: R) => PropertySet[];
}

/**
 * Sum a named quantity across every quantity set on every element ref,
 * adding up all matches ("Gross" and "Net" names given as alternatives —
 * Gross/Net are two names for a slot the model only ever fills one of, not
 * two quantities to add). A quantity set holding two quantities with the
 * same name is not valid IFC — IfcElementQuantity's UniqueQuantityNames
 * WHERE rule forbids it — so this function does not try to guess intent
 * for non-compliant data; it just sums whatever is present. Returns 0 for
 * an empty list — the caller decides what an empty aggregate means (e.g. a
 * GFA fallback).
 */
export function sumQuantity<R>(bim: QuantityBim<R>, refs: R[], quantityNames: string[]): number {
  let total = 0;
  for (const ref of refs) {
    const qsets = bim.quantities(ref);
    for (const qset of qsets) {
      for (const q of qset.quantities) {
        if (quantityNames.includes(q.name)) {
          total += Number(q.value) || 0;
        }
      }
    }
  }
  return total;
}

/** Read a single property's value out of a named property set, or undefined. */
export function getPropertyValue<R>(bim: PropertyBim<R>, ref: R, psetName: string, propName: string): unknown {
  try {
    const psets = bim.properties(ref).filter(
      (pset): pset is PropertySet & { properties: Array<{ name: string; value: unknown }> } =>
        pset.properties !== undefined,
    );
    const prop = findPropertyInSets(psets, psetName, propName);
    if (prop) return prop.value;
  } catch {
    // Property not available
  }
  return undefined;
}

/** IFC boolean-logical literals that mean "true" across the encodings the parser hands back. */
export function isTruthyIfcBoolean(value: unknown): boolean {
  return value === true || value === 'TRUE' || value === '.T.';
}

export interface WallAggregate {
  totalWallArea: number;
  exteriorWallArea: number;
  totalWallVolume: number;
}

/**
 * Per-wall area/volume aggregation, plus the exterior-wall-area subtotal
 * used as the Window-Wall-Ratio denominator. `exteriorWallArea` is a SUBSET
 * of `totalWallArea` (every exterior wall's area is counted in both), not a
 * separate quantity — callers must not sum them.
 */
export function aggregateWalls<R>(
  bim: QuantityBim<R> & PropertyBim<R>,
  walls: Array<{ ref: R }>,
): WallAggregate {
  let totalWallArea = 0;
  let exteriorWallArea = 0;
  let totalWallVolume = 0;
  for (const w of walls) {
    let wallArea = 0;
    let wallVolume = 0;
    const qsets = bim.quantities(w.ref);
    for (const qset of qsets) {
      for (const q of qset.quantities) {
        if (q.name === 'GrossSideArea' || q.name === 'NetSideArea') {
          wallArea = Number(q.value) || 0;
        }
        if (q.name === 'GrossVolume' || q.name === 'NetVolume') {
          wallVolume = Number(q.value) || 0;
        }
      }
    }
    totalWallArea += wallArea;
    totalWallVolume += wallVolume;

    const isExternal = getPropertyValue(bim, w.ref, 'Pset_WallCommon', 'IsExternal');
    if (isTruthyIfcBoolean(isExternal)) {
      exteriorWallArea += wallArea;
    }
  }
  return { totalWallArea, exteriorWallArea, totalWallVolume };
}

/**
 * Window-Wall Ratio as a percentage. Uses exterior wall area when any exists
 * (the architecturally meaningful denominator); falls back to total wall
 * area only when there is no exterior-wall data at all — NOT when exterior
 * area happens to be smaller, and not summed with total wall area.
 */
export function computeWindowWallRatio(totalWindowArea: number, exteriorWallArea: number, totalWallArea: number): number {
  const wwrBase = exteriorWallArea > 0 ? exteriorWallArea : totalWallArea;
  return wwrBase > 0 ? (totalWindowArea / wwrBase) * 100 : 0;
}

/**
 * Gross Floor Area: sum of each storey's own `GrossFloorArea` quantity
 * (a storey with none contributes 0, i.e. an empty group — it must not be
 * skipped or it would silently undercount). Falls back to the model's total
 * slab floor area only when the storey-quantity sum is exactly 0 (no storey
 * anywhere reports GFA), not per-storey.
 */
export function computeGrossFloorArea<R>(
  bim: QuantityBim<R>,
  storeys: Array<{ ref: R }>,
  fallbackTotalFloorArea: number,
): number {
  const grossFloorArea = sumQuantity(bim, storeys.map(s => s.ref), ['GrossFloorArea']);
  return grossFloorArea === 0 ? fallbackTotalFloorArea : grossFloorArea;
}

/**
 * Distinct, display-ready storey names: blank/whitespace-only Names
 * (`IFCBUILDINGSTOREY('...','',...)`) are dropped, same as a genuinely
 * absent one, rather than surfacing as a blank entry in the storey list.
 */
export function computeStoreyNames(storeys: Array<{ name?: string | null }>): string[] {
  return storeys.map(s => s.name).filter((name): name is string => !isBlank(name));
}

/**
 * The first `IfcBuilding`'s display name, or `'(unnamed)'` when absent OR
 * blank/whitespace-only — `?? '(unnamed)'` alone only falls through on
 * null/undefined, so a present-but-blank `Name` was returned verbatim.
 */
export function computeBuildingName(buildings: Array<{ name?: string | null }>): string {
  return firstNonBlank(buildings[0]?.name) ?? '(unnamed)';
}

export interface MaterialSummaryEntry {
  name: string;
  count: number;
  volume: number;
}

export interface MaterialsBim<R = unknown> extends QuantityBim<R> {
  materials: (ref: R) => { materials?: Array<string | { name?: string }>; name?: string } | null | undefined;
}

/**
 * Per-material element count and summed Gross/NetVolume, sorted by element
 * count descending (most common material first).
 */
export function computeMaterialSummary<R>(
  bim: MaterialsBim<R>,
  elements: Array<{ ref: R }>,
  round: (n: number) => number,
): MaterialSummaryEntry[] {
  const materialVolumes = new Map<string, number>();
  const materialCounts = new Map<string, number>();
  for (const e of elements) {
    const mat = bim.materials(e.ref);
    const first = mat?.materials?.[0];
    const firstName = typeof first === 'string' ? first : first?.name;
    // A whitespace-only name (`IFCMATERIAL('   ',$,$)`) is falsy-but-truthy
    // — a bare `!matName` guard on `firstName ?? mat?.name` let it through
    // as a whitespace-string map key instead of skipping it like a
    // genuinely blank/absent one.
    const matName = firstNonBlank(firstName, mat?.name);
    if (!matName) continue;

    materialCounts.set(matName, (materialCounts.get(matName) ?? 0) + 1);

    const qsets = bim.quantities(e.ref);
    for (const qset of qsets) {
      for (const q of qset.quantities) {
        if (q.name === 'GrossVolume' || q.name === 'NetVolume') {
          materialVolumes.set(matName, (materialVolumes.get(matName) ?? 0) + (Number(q.value) || 0));
          break;
        }
      }
    }
  }

  return [...materialCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({
      name,
      count,
      volume: round(materialVolumes.get(name) ?? 0),
    }));
}

export interface ValidationSummary {
  duplicateGlobalIds: number;
  unnamedElements: number;
}

/**
 * Model-health checks: how many GlobalIds are duplicated (a count of
 * *offending IDs*, not of duplicate rows — three elements sharing one
 * GlobalId count as 1 here, matching the original implementation) and how
 * many elements have no name / an empty-string name.
 */
export function computeValidation(elements: Array<{ globalId?: unknown; name?: unknown }>): ValidationSummary {
  const globalIds = elements.map(e => e.globalId).filter(Boolean) as string[];
  const globalIdCounts = new Map<string, number>();
  for (const id of globalIds) {
    globalIdCounts.set(id, (globalIdCounts.get(id) ?? 0) + 1);
  }
  const duplicateGlobalIds = [...globalIdCounts.entries()].filter(([, count]) => count > 1).length;
  const unnamedElements = elements.filter(e => !e.name || e.name === '').length;
  return { duplicateGlobalIds, unnamedElements };
}
