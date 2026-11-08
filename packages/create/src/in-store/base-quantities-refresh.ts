/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Refreshed base quantities of a LOADED element whose geometry was edited this
 * session (#9026 item 20 follow-up). Opt-in: the viewer calls these only while
 * "Update quantities of edited elements" is on, so with it off a loaded file
 * reads exactly as `base-quantities.ts` leaves it.
 *
 * The values come from the same derivation an authored element reads
 * (`deriveBaseQuantitySet`), and like it they are derived, never stored: undo
 * of the edit undoes the refresh, and nothing is journalled.
 *
 * "Edited" means the live geometry gives different quantities from the file's
 * own geometry, both read by the same readers. Comparing against the file's
 * stored values instead would flag every element whose authoring tool
 * measures differently (joins, Revit's net areas), and listing the writers
 * that edit geometry would miss the ones that bypass any one chokepoint.
 *
 * Within that set, only a quantity whose derived value the edit changed is
 * rewritten; the rest keep the file's values.
 *
 * Only a set the file already has is refreshed: the element's standard
 * `Qto_*BaseQuantities`, or an IFC2X3-style set named `BaseQuantities`, which
 * keeps its name. An element the file gave no base quantities gains none.
 */

import type { QuantitySet } from '@ifc-lite/data';
import { MutablePropertyView, type QuantityBaseRevision } from '@ifc-lite/mutations';
import { extractQuantitiesOnDemand, type IfcDataStore } from '@ifc-lite/parser';
import { deriveBaseQuantitySet } from './base-quantities.js';
import { baseQuantitySetName, effectiveElementType } from './base-quantities-kinds.js';
import { editedElementCandidates } from './base-quantities-edited-index.js';

/** The set name IFC2X3 exporters commonly gave an element's base quantities. */
const LEGACY_BASE_QUANTITIES = 'BaseQuantities';

/** One view with no overlay per store: the file's own geometry, read by the same readers as the live one. */
const pristineViews = new WeakMap<IfcDataStore, MutablePropertyView>();

function pristineView(dataStore: IfcDataStore): MutablePropertyView {
  let view = pristineViews.get(dataStore);
  if (!view) {
    view = new MutablePropertyView(null, '__file-geometry__');
    pristineViews.set(dataStore, view);
  }
  return view;
}

/**
 * Equal to well below any edit. The derivation reads lengths off placed points,
 * so at large storey-local coordinates a move alone shifts the last digits.
 */
const sameValue = (a: number | undefined, b: number | undefined): boolean =>
  a !== undefined && b !== undefined && Math.abs(a - b) <= 1e-9 * Math.max(Math.abs(a), Math.abs(b), 1e-3);

function sameQuantities(a: QuantitySet, b: QuantitySet): boolean {
  return a.quantities.length === b.quantities.length
    && a.quantities.every((q, i) => q.name === b.quantities[i].name && sameValue(q.value, b.quantities[i].value));
}

/** Per view, store and overlay revision: the export's candidates, which every read is gated on too. */
const candidatesByView = new WeakMap<MutablePropertyView, { dataStore: IfcDataStore; revision: number; ids: Set<number> }>();

function candidates(dataStore: IfcDataStore, view: MutablePropertyView): Set<number> {
  const revision = view.getMutationRevision();
  const known = candidatesByView.get(view);
  if (known?.dataStore === dataStore && known.revision === revision) return known.ids;
  const ids = editedElementCandidates(dataStore, view);
  candidatesByView.set(view, { dataStore, revision, ids });
  return ids;
}

/** The file set a refresh of `expressId` replaces, without reading any geometry. */
function refreshTarget(dataStore: IfcDataStore, view: MutablePropertyView, expressId: number, fileSets: readonly QuantitySet[]): QuantitySet | null {
  // Authored elements and copies have their own path in `deriveAuthoredBaseQuantities`.
  if (fileSets.length === 0 || view.getNewEntity(expressId)) return null;
  const name = baseQuantitySetName(effectiveElementType(dataStore, view, expressId));
  if (!name) return null;
  return fileSets.find((set) => set.name === name) ?? fileSets.find((set) => set.name === LEGACY_BASE_QUANTITIES) ?? null;
}

/**
 * The refreshed set for a loaded element, or null when it is not one of the
 * supported kinds, has no base quantity set in the file, or its geometry
 * gives the same quantities it did in the file.
 */
function refreshedSet(dataStore: IfcDataStore, view: MutablePropertyView, expressId: number, fileSets: readonly QuantitySet[]): { target: QuantitySet; refreshed: QuantitySet } | null {
  const target = refreshTarget(dataStore, view, expressId, fileSets);
  // Only an element the overlay touched is read: the export nominates the same ones, and a list over a large file stays cheap.
  if (!target || !candidates(dataStore, view).has(expressId)) return null;
  const live = deriveBaseQuantitySet(dataStore, view, expressId);
  if (!live) return null;
  const file = deriveBaseQuantitySet(dataStore, pristineView(dataStore), expressId);
  if (file && sameQuantities(live, file)) return null;
  // A quantity the edit did not change keeps the file's own value: its authoring tool may measure it
  // its own way (ArchiCAD's wall Length stops at the join, the axis runs to it), and a height edit
  // should not rewrite a length. One the derivation does not give is left out rather than left stale.
  const before = new Map(file?.quantities.map((q) => [q.name, q.value]));
  const own = new Map(target.quantities.map((q) => [q.name, q]));
  const quantities = live.quantities.map((q) => {
    const kept = own.get(q.name);
    return kept && sameValue(before.get(q.name), q.value) ? kept : q;
  });
  // The file's set name and GlobalId stay, so its export replaces that set rather than add a second one.
  return { target, refreshed: { name: target.name, globalId: target.globalId, quantities } };
}

/**
 * `fileSets` (a loaded element's own sets, as the file has them) with its base
 * quantity set replaced by one read from its edited geometry. Returns
 * `fileSets` itself when nothing was refreshed.
 */
export function withRefreshedBaseQuantities(dataStore: IfcDataStore, view: MutablePropertyView, expressId: number, fileSets: QuantitySet[]): QuantitySet[] {
  const found = refreshedSet(dataStore, view, expressId, fileSets);
  // By identity: a second same-named set in the file is a different set and stays as it is.
  return found ? fileSets.map((set) => (set === found.target ? found.refreshed : set)) : fileSets;
}

/**
 * The set `withRefreshedBaseQuantities` puts in for `expressId`, for a "from
 * geometry" marker; null when none is. The whole set, not its name: a file can
 * give an element a second set of the same name, which stays as it was.
 */
export function refreshedBaseQuantitySet(dataStore: IfcDataStore, view: MutablePropertyView, expressId: number): QuantitySet | null {
  const id = view.resolveBaseEntityId(expressId);
  if (id !== expressId) return null;
  return refreshedSet(dataStore, view, id, extractQuantitiesOnDemand(dataStore, id, view))?.refreshed ?? null;
}

/** Whether `expressId` is a loaded element whose base quantity set a geometry edit would refresh. */
export function hasRefreshableBaseQuantities(dataStore: IfcDataStore, view: MutablePropertyView, expressId: number): boolean {
  if (view.resolveBaseEntityId(expressId) !== expressId) return false;
  return refreshTarget(dataStore, view, expressId, extractQuantitiesOnDemand(dataStore, expressId, view)) !== null;
}

/**
 * Every refreshed set in the session, for the exporter
 * (`MutablePropertyView.setQuantityBaseRevisions`). Only elements whose file
 * geometry the overlay touches are read, so an unedited file costs a check
 * of the overlay and nothing more.
 */
export function refreshedBaseQuantitySets(dataStore: IfcDataStore, view: MutablePropertyView): QuantityBaseRevision[] {
  const revisions: QuantityBaseRevision[] = [];
  for (const entityId of candidates(dataStore, view)) {
    if (view.isDeleted(entityId)) continue;
    const setName = refreshedBaseQuantitySet(dataStore, view, entityId)?.name;
    if (setName) revisions.push({ entityId, setName });
  }
  return revisions;
}
