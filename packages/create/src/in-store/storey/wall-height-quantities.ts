/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { ROOF_ATTACHMENT } from '../edit/wall-base-solid.js';
import type { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { extractProjectUnits, extractQuantitiesOnDemand, quantitySiScale, type IfcDataStore, type ProjectUnits } from '@ifc-lite/parser';
import type { QuantitySet, QuantityType } from '@ifc-lite/data';
import { readWallMetres } from '../wall-size-edit.js';

export const WALL_QTO = 'Qto_WallBaseQuantities';

/** Snapshot before changing the body: a registered quantity base may derive from live geometry. */
export function snapshotWallQuantities(store: IfcDataStore, view: MutablePropertyView, wallId: number): QuantitySet | null {
  const base = view.hasQuantityBase() ? undefined : (id: number) => extractQuantitiesOnDemand(store, id);
  const qto = view.getQuantitiesForEntity(wallId, base).find(set => set.name === WALL_QTO);
  return qto ? { ...qto, quantities: qto.quantities.map(quantity => ({ ...quantity })) } : null;
}

/**
 * Keep an existing Qto_WallBaseQuantities true to a height change by factor
 * `k`. A wall is a prism along its height, so Height and the gross side area
 * and volume scale by `k`; the net values lose the same openings before and
 * after, so they change by exactly the gross change. Unit-free, since every
 * value keeps the unit it was written in. A wall without the set gets none.
 * A view with no quantity base of its own reads the source quantities here,
 * so a set that exists only in the file is kept true too. Without a gross
 * value, the set's Length, Height and Width give the gross prism, else the
 * wall's own `geometry` (metres, read before the resize).
 */
export function scaleWallQuantities(
  store: IfcDataStore, view: MutablePropertyView, wallId: number, k: number, geometry?: WallGeometry, before?: QuantitySet | null,
): void {
  if (view.getPropertyValue(wallId, ROOF_ATTACHMENT, 'Clipped') === true) return;
  const qto = before === undefined ? snapshotWallQuantities(store, view, wallId) : before;
  if (!qto || !Number.isFinite(k)) return;
  const value = (name: string) => qto.quantities.find((q) => q.name === name);
  const set = (name: string, next: number) => {
    const quantity = value(name);
    if (quantity && Number.isFinite(next)) view.setQuantity(wallId, WALL_QTO, name, next, quantity.type, quantity.unit);
  };
  const height = value('Height');
  if (height) set('Height', height.value * k);
  // Quantities may carry their own unit (a NetSideArea in mm² beside a GrossSideArea in m²):
  // the arithmetic between them runs in SI, each read through its own scale.
  let units: ProjectUnits | null = null;
  const scaleOf = (q: { name: string; type: QuantityType; value: number } | undefined): number | undefined => {
    if (!q) return undefined;
    units ??= extractProjectUnits(store.source, store.entityIndex);
    const explicit = 'explicitUnitSiScale' in q && typeof q.explicitUnitSiScale === 'number' ? { explicitUnitSiScale: q.explicitUnitSiScale } : {};
    const scale = quantitySiScale({ name: q.name, type: q.type, value: q.value, ...explicit }, units);
    return Number.isFinite(scale) && scale > 0 ? scale : undefined;
  };
  const si = (q: { name: string; type: QuantityType; value: number } | undefined): number | undefined => {
    const scale = scaleOf(q);
    return q && scale !== undefined ? q.value * scale : undefined;
  };
  // Without the gross value, the set's own Length × Height (× Width) is the gross prism it stands for.
  const length = si(value('Length')), width = si(value('Width')), h = si(height);
  // The set's own dimensions first (they are what its other values were measured with), then the wall's geometry.
  const grossFromSet = {
    GrossSideArea: length !== undefined && h !== undefined ? length * h
      : geometry ? geometry.length * geometry.height : undefined,
    GrossVolume: length !== undefined && width !== undefined && h !== undefined ? length * width * h
      : geometry ? geometry.length * geometry.thickness * geometry.height : undefined,
  };
  for (const [gross, net] of [['GrossSideArea', 'NetSideArea'], ['GrossVolume', 'NetVolume']] as const) {
    const g = value(gross), n = value(net);
    if (g) set(gross, g.value * k);
    if (!n) continue;
    // Openings are the same before and after, so the net value changes by exactly the gross change.
    const beforeSi = si(g) ?? grossFromSet[gross];
    const netScale = scaleOf(n);
    set(net, beforeSi !== undefined && netScale !== undefined ? n.value + beforeSi * (k - 1) / netScale : n.value * k);
  }
}

/** A wall's prism in metres (SI), for quantity upkeep. */
export interface WallGeometry { readonly length: number; readonly thickness: number; readonly height: number }

/** The wall's length, thickness and height before a resize, or undefined when it cannot be read. */
export function wallGeometry(store: IfcDataStore, view: MutablePropertyView, editor: StoreEditor, wallId: number): WallGeometry | undefined {
  const wall = readWallMetres({ dataStore: store, view, editor }, wallId);
  if (!wall) return undefined;
  const length = Math.hypot(wall.end[0] - wall.start[0], wall.end[1] - wall.start[1], wall.end[2] - wall.start[2]);
  return [length, wall.thickness, wall.height].every((v) => Number.isFinite(v) && v > 0)
    ? { length, thickness: wall.thickness, height: wall.height } : undefined;
}
