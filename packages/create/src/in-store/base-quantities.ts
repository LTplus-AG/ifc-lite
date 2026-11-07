/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Base quantities of an element authored this session, read off its live
 * geometry (#9026 item 20).
 *
 * They are DERIVED, never stored. Dozens of writers change an authored
 * element's shape (resize, push/pull, split, trim, joins, a door cut, raw STEP,
 * scripts, undo of any of those), and a stored set would need every one of them
 * to refresh it. Reading the shape on demand leaves nothing to go stale.
 *
 * The answer sits under the mutation view as its quantity base
 * (`MutablePropertyView.setQuantityExtractor`), so whoever reads the view gets it,
 * and a person's own edit or deletion of a set applies on top as it does on a
 * loaded file's. The STEP exporter writes the same answer
 * (`step-derived-quantities.ts`), so the tab and the file cannot disagree.
 *
 * Only overlay-created elements qualify, so a loaded file reads as it always did.
 * A copy of a loaded element reads its source's sets, as it always did.
 */

import { QuantityType, type QuantitySet } from '@ifc-lite/data';
import { StoreEditor, type MutablePropertyView } from '@ifc-lite/mutations';
import { extractProjectUnits, type IfcDataStore } from '@ifc-lite/parser';
import { toNativeLength, type HostBounds } from './anchor.js';
import {
  axisOverlap,
  clippedPolygonArea,
  polygonArea,
  polygonPerimeter,
  sectionMeasures,
} from './base-quantities-measure.js';
import { asExpressIdRef, readAttributes } from './edit/placement-core.js';
import { getModelLengthUnitScale } from './edit/length-unit-scale.js';
import { resolveLinearElementChain } from './edit/linear-element-edit.js';
import { resolveSlabEditChain } from './edit/slab-edit.js';
import { localBodyExtent, placedBodyExtent } from './resolve-host.js';
import { wallBodyOutline } from './wall-join.js';
import { readWallJoinTarget } from './wall-join-read.js';

const WALL_TYPES = new Set(['IFCWALL', 'IFCWALLSTANDARDCASE']);
const SLAB_TYPES = new Set(['IFCSLAB', 'IFCROOF']);
const LINEAR_TYPES = new Set(['IFCCOLUMN', 'IFCBEAM']);

/** A quantity in SI, on its way to the file's own units. */
type Row = readonly [name: string, type: QuantityType.Length | QuantityType.Area | QuantityType.Volume, value: number];

interface Reading {
  readonly dataStore: IfcDataStore;
  readonly view: MutablePropertyView;
  readonly editor: StoreEditor;
  readonly scale: number;
  readonly openings: ReadonlyMap<number, readonly number[]>;
}

interface Revision {
  readonly dataStore: IfcDataStore;
  readonly revision: number;
  readonly editor: StoreEditor;
  readonly sets: Map<number, QuantitySet[]>;
  openings: ReadonlyMap<number, readonly number[]> | null;
}

/** Per view, store and overlay revision: a list or an export reads every element, and a write or a store swap starts over. */
const revisions = new WeakMap<MutablePropertyView, Revision>();

function revisionOf(dataStore: IfcDataStore, view: MutablePropertyView): Revision {
  const revision = view.getMutationRevision();
  const known = revisions.get(view);
  const sameStore = known?.dataStore === dataStore;
  if (sameStore && known.revision === revision) return known;
  // The editor scans the source once for its id floor, so it outlives a revision of its store.
  const editor = sameStore ? known.editor : new StoreEditor(dataStore, view);
  const next: Revision = { dataStore, revision, editor, sets: new Map(), openings: null };
  revisions.set(view, next);
  return next;
}

/**
 * Host id to the openings voiding it. Overlay relationships only: a host created
 * this session is voided by one created this session, and walking a loaded file's
 * relationships per click would cost a large model far more than it could find.
 */
function overlayOpenings(dataStore: IfcDataStore, view: MutablePropertyView, editor: StoreEditor): Map<number, number[]> {
  const byHost = new Map<number, number[]>();
  for (const rel of view.getNewEntitiesOfType('IFCRELVOIDSELEMENT')) {
    const attributes = readAttributes(dataStore, view, editor, rel.expressId);
    const host = asExpressIdRef(attributes?.[4]);
    const opening = asExpressIdRef(attributes?.[5]);
    if (host === null || opening === null) continue;
    const list = byHost.get(host);
    if (list) list.push(opening);
    else byHost.set(host, [opening]);
  }
  return byHost;
}

const projectUnitScales = new WeakMap<IfcDataStore, { area: number; volume: number }>();

/** IfcQuantityArea and IfcQuantityVolume are written in the project's own units for those measures. */
function unitScales(dataStore: IfcDataStore): { area: number; volume: number } {
  let scales = projectUnitScales.get(dataStore);
  if (!scales) {
    const units = dataStore.source?.length && dataStore.entityIndex ? extractProjectUnits(dataStore.source, dataStore.entityIndex) : null;
    scales = {
      area: units?.resolvedForUnitType('AREAUNIT')?.siScale ?? 1,
      volume: units?.resolvedForUnitType('VOLUMEUNIT')?.siScale ?? 1,
    };
    projectUnitScales.set(dataStore, scales);
  }
  return scales;
}

/** Twelve significant figures: 5 x 0.2 x 3 reads 3, not 3.0000000000000004. */
const clean = (value: number): number => Number(value.toPrecision(12));

function toQuantitySet(dataStore: IfcDataStore, scale: number, name: string, rows: readonly Row[]): QuantitySet {
  const { area, volume } = unitScales(dataStore);
  const native = (type: Row[1], metric: number): number => {
    if (type === QuantityType.Length) return toNativeLength({ lengthUnitScale: scale }, metric);
    return metric / (type === QuantityType.Area ? area : volume);
  };
  return { name, quantities: rows.map(([quantity, type, value]) => ({ name: quantity, type, value: clean(native(type, value)) })) };
}

/** The boxes of `hostId`'s openings in its frame, in metres; null when one cannot be read. */
function openingBoxes(reading: Reading, hostId: number): HostBounds[] | null {
  const boxes: HostBounds[] = [];
  for (const openingId of reading.openings.get(hostId) ?? []) {
    const extent = placedBodyExtent(reading.dataStore, openingId, reading.view);
    if (!extent) {
      console.warn(`[quantities] opening #${openingId} of #${hostId} is unreadable; its host reports gross quantities only`);
      return null;
    }
    const metres = (point: readonly number[]) => point.map((value) => value * reading.scale) as [number, number, number];
    boxes.push({ min: metres(extent.min), max: metres(extent.max) });
  }
  return boxes;
}

function hostBox(reading: Reading, hostId: number): HostBounds | null {
  const extent = localBodyExtent(reading.dataStore, hostId, reading.view);
  if (!extent) return null;
  const metres = (point: readonly number[]) => point.map((value) => value * reading.scale) as [number, number, number];
  return { min: metres(extent.min), max: metres(extent.max) };
}

function wallSet(reading: Reading, id: number): QuantitySet | null {
  const read = readWallJoinTarget(reading.dataStore, reading.view, id, reading.scale);
  if (!read || !(read.height > 0)) return null;
  const { wall, height } = read;
  const length = Math.hypot(wall.end[0] - wall.start[0], wall.end[1] - wall.start[1]);
  const footprint = polygonArea(wallBodyOutline(wall).corners);
  const side = length * height;
  const volume = footprint * height;
  const footprintKey = reading.dataStore.schemaVersion?.startsWith('IFC4X3') ? 'FootPrintArea' : 'FootprintArea';
  const rows: Row[] = [
    ['Length', QuantityType.Length, length],
    ['Width', QuantityType.Length, wall.thickness],
    ['Height', QuantityType.Length, height],
    [`Gross${footprintKey}`, QuantityType.Area, footprint],
    ['GrossSideArea', QuantityType.Area, side],
    ['GrossVolume', QuantityType.Volume, volume],
  ];
  // A wall's openings subtract from its net side area and volume, and from its
  // footprint where they reach the floor: a door does, a window with a sill does not.
  const boxes = openingBoxes(reading, id);
  const body = boxes && (boxes.length === 0 ? null : hostBox(reading, id));
  if (boxes && (boxes.length === 0 || body)) {
    let netFootprint = footprint;
    let netSide = side;
    let netVolume = volume;
    for (const box of boxes) {
      const x = axisOverlap(box, body!, 0);
      const y = axisOverlap(box, body!, 1);
      const z = axisOverlap(box, body!, 2);
      netSide -= x * z;
      netVolume -= x * y * z;
      if (box.min[2] <= body!.min[2] + 1e-6) netFootprint -= x * y;
    }
    rows.push(
      [`Net${footprintKey}`, QuantityType.Area, Math.max(0, netFootprint)],
      ['NetSideArea', QuantityType.Area, Math.max(0, netSide)],
      ['NetVolume', QuantityType.Volume, Math.max(0, netVolume)],
    );
  }
  return toQuantitySet(reading.dataStore, reading.scale, 'Qto_WallBaseQuantities', rows);
}

function slabLikeSet(reading: Reading, id: number, isRoof: boolean): QuantitySet | null {
  const { dataStore, view, editor, scale } = reading;
  const chain = resolveSlabEditChain(dataStore, view, editor, id, scale);
  // A tilted extrusion has no plan area to report as its own; the builders never write one.
  if (!chain || chain.baseElevation === null) return null;
  const area = polygonArea(chain.footprint);
  // The footprint is storey-local with the placement origin added; an opening's box is in the host's frame.
  const local = chain.footprint.map(([x, y]) => [x - chain.placementOrigin[0], y - chain.placementOrigin[1]] as [number, number]);
  const boxes = openingBoxes(reading, id);
  const body = boxes && (boxes.length === 0 ? null : hostBox(reading, id));
  const readable = boxes !== null && (boxes.length === 0 || body !== null);
  const cuts = readable ? boxes.map((box) => ({ area: clippedPolygonArea(local, box), depth: body ? axisOverlap(box, body, 2) : 0 })) : [];
  const netArea = readable ? Math.max(0, area - cuts.reduce((sum, cut) => sum + cut.area, 0)) : null;
  if (isRoof) {
    const rows: Row[] = [['GrossArea', QuantityType.Area, area], ['ProjectedArea', QuantityType.Area, area]];
    if (netArea !== null) rows.push(['NetArea', QuantityType.Area, netArea]);
    return toQuantitySet(dataStore, scale, 'Qto_RoofBaseQuantities', rows);
  }
  const rows: Row[] = [['Width', QuantityType.Length, chain.thickness]];
  if (chain.profileKind === 'rectangle') {
    // Length and Depth are the plan's two sides, and the schema gives them only for a rectangle.
    const xs = local.map(([x]) => x);
    const ys = local.map(([, y]) => y);
    rows.push(['Length', QuantityType.Length, Math.max(...xs) - Math.min(...xs)], ['Depth', QuantityType.Length, Math.max(...ys) - Math.min(...ys)]);
  }
  rows.push(
    ['Perimeter', QuantityType.Length, polygonPerimeter(chain.footprint)],
    ['GrossArea', QuantityType.Area, area],
    ['GrossVolume', QuantityType.Volume, area * chain.thickness],
  );
  // A recess lowers the net area by its plan and the net volume only by the depth it reaches into the body.
  if (netArea !== null) {
    const removed = cuts.reduce((sum, cut) => sum + cut.area * cut.depth, 0);
    rows.push(['NetArea', QuantityType.Area, netArea], ['NetVolume', QuantityType.Volume, Math.max(0, area * chain.thickness - removed)]);
  }
  return toQuantitySet(dataStore, scale, 'Qto_SlabBaseQuantities', rows);
}

function linearSet(reading: Reading, id: number, type: string): QuantitySet | null {
  const { dataStore, view, editor, scale } = reading;
  const chain = resolveLinearElementChain(dataStore, view, editor, id, scale);
  if (!chain) return null;
  const section = sectionMeasures(chain.profile, chain.profileWidth, chain.profileHeight);
  if (!section) return null;
  const outer = section.perimeter * chain.depth;
  const gross = outer + 2 * section.area;
  const volume = section.area * chain.depth;
  const rows: Row[] = [
    ['Length', QuantityType.Length, chain.depth],
    ['CrossSectionArea', QuantityType.Area, section.area],
    ['OuterSurfaceArea', QuantityType.Area, outer],
    ['GrossSurfaceArea', QuantityType.Area, gross],
    ['GrossVolume', QuantityType.Volume, volume],
  ];
  // The authoring tools cut only walls and slabs. A void written some other way lowers the net volume,
  // but which outer faces it removes is not knowable from its box, so the net surface is left out.
  const boxes = openingBoxes(reading, id);
  const body = boxes && (boxes.length === 0 ? null : hostBox(reading, id));
  if (boxes && (boxes.length === 0 || body)) {
    const cut = boxes.reduce((sum, box) => sum + axisOverlap(box, body!, 0) * axisOverlap(box, body!, 1) * axisOverlap(box, body!, 2), 0);
    if (boxes.length === 0) rows.push(['NetSurfaceArea', QuantityType.Area, gross]);
    rows.push(['NetVolume', QuantityType.Volume, Math.max(0, volume - cut)]);
  }
  return toQuantitySet(dataStore, scale, type === 'IFCCOLUMN' ? 'Qto_ColumnBaseQuantities' : 'Qto_BeamBaseQuantities', rows);
}

/**
 * The base quantity sets `expressId` has from its geometry: a wall, slab, roof,
 * column or beam created in this overlay with a body these readers understand.
 * Empty for anything else, including every element of a loaded file.
 */
export function deriveAuthoredBaseQuantities(dataStore: IfcDataStore, view: MutablePropertyView, expressId: number): QuantitySet[] {
  const created = view.getNewEntity(expressId);
  if (!created || !view.getNewEntity(view.resolveBaseEntityId(expressId))) return [];
  // A retype's class is the one the export writes.
  const type = (view.getEntityTypeMutation(expressId)?.newType ?? created.type).toUpperCase();
  const isWall = WALL_TYPES.has(type);
  const isSlabLike = SLAB_TYPES.has(type);
  if (!isWall && !isSlabLike && !LINEAR_TYPES.has(type)) return [];

  const revision = revisionOf(dataStore, view);
  const known = revision.sets.get(expressId);
  if (known) return known;
  let sets: QuantitySet[] = [];
  try {
    const { editor } = revision;
    revision.openings ??= overlayOpenings(dataStore, view, editor);
    const reading: Reading = { dataStore, view, editor, scale: getModelLengthUnitScale(dataStore), openings: revision.openings };
    const set = isWall ? wallSet(reading, expressId) : isSlabLike ? slabLikeSet(reading, expressId, type === 'IFCROOF') : linearSet(reading, expressId, type);
    if (set) sets = [set];
  } catch (error) {
    console.warn(`[quantities] #${expressId} has no base quantities: its geometry could not be read`, error);
  }
  revision.sets.set(expressId, sets);
  return sets;
}
