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
import { uuidToIfcGuid, uuidV5 } from '@ifc-lite/encoding';
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
import { asExpressIdRef, readAttributes, resolvePlacementChain } from './edit/placement-core.js';
import { getModelLengthUnitScale } from './edit/length-unit-scale.js';
import { resolveLinearElementChain } from './edit/linear-element-edit.js';
import { resolveSlabEditChain } from './edit/slab-edit.js';
import { slabExtrusionFrame } from './edit/slab-edit-frame.js';
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

/** ifc-lite's fixed namespace for derived quantity set GlobalIds. Never change it: saved models depend on it. */
const DERIVED_SET_NAMESPACE = 'b8e0d7a4-5f2c-4e1b-8c3d-6a9f1e2b7c45';

/** A name-based id from the element's GlobalId and the set's name, so each export writes the same one. */
function setGlobalId(reading: Reading, id: number, name: string): string | undefined {
  const elementGlobalId = readAttributes(reading.dataStore, reading.view, reading.editor, id)?.[0];
  return typeof elementGlobalId === 'string' && elementGlobalId.length > 0
    ? uuidToIfcGuid(uuidV5(DERIVED_SET_NAMESPACE, `${elementGlobalId}/${name}`)) : undefined;
}

function toQuantitySet(dataStore: IfcDataStore, scale: number, name: string, rows: readonly Row[]): QuantitySet {
  const { area, volume } = unitScales(dataStore);
  const native = (type: Row[1], metric: number): number => {
    if (type === QuantityType.Length) return toNativeLength({ lengthUnitScale: scale }, metric);
    return metric / (type === QuantityType.Area ? area : volume);
  };
  return { name, quantities: rows.map(([quantity, type, value]) => ({ name: quantity, type, value: clean(native(type, value)) })) };
}

const boxVolume = (box: HostBounds): number => (box.max[0] - box.min[0]) * (box.max[1] - box.min[1]) * (box.max[2] - box.min[2]);

/**
 * The boxes of `hostId`'s openings in its frame, in metres; null when one cannot
 * be read, or is turned against the host's axes so its box would overstate it
 * (its own body fills its placed box only when the two are aligned).
 */
function openingBoxes(reading: Reading, hostId: number): HostBounds[] | null {
  const boxes: HostBounds[] = [];
  for (const openingId of reading.openings.get(hostId) ?? []) {
    const extent = placedBodyExtent(reading.dataStore, openingId, reading.view);
    const own = extent && localBodyExtent(reading.dataStore, openingId, reading.view);
    if (!extent || !own) {
      console.warn(`[quantities] opening #${openingId} of #${hostId} is unreadable; its host reports gross quantities only`);
      return null;
    }
    if (Math.abs(boxVolume(extent) - boxVolume(own)) > 1e-6 * Math.max(boxVolume(own), 1e-12)) {
      console.warn(`[quantities] opening #${openingId} is turned against #${hostId}'s axes; its host reports gross quantities only`);
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
  const outline = wallBodyOutline(wall);
  const footprint = polygonArea(outline.corners);
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
  // Only an opening that meets the body cuts it; one moved clear of it changes nothing.
  const cutting = boxes && body ? boxes.filter((box) => axisOverlap(box, body, 0) * axisOverlap(box, body, 1) * axisOverlap(box, body, 2) > 0) : [];
  if (boxes && (boxes.length === 0 || (body && withinFullThickness(read, outline, cutting)))) {
    let netFootprint = footprint;
    let netSide = side;
    let netVolume = volume;
    for (const box of cutting) {
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

/**
 * Whether every opening lies along the stretch where a joined wall has its
 * whole thickness: beyond it, a mitre has cut the body's box away, and the
 * box overlap would subtract wall that is not there.
 */
function withinFullThickness(read: { origin: readonly [number, number]; wall: { start: readonly [number, number]; end: readonly [number, number] } },
  outline: ReturnType<typeof wallBodyOutline>, boxes: readonly HostBounds[]): boolean {
  if (outline.rectangular) return true;
  const { wall, origin } = read;
  const length = Math.hypot(wall.end[0] - wall.start[0], wall.end[1] - wall.start[1]);
  // The outline is measured from the axis Start; an opening's box from the placement origin.
  const along = ((wall.start[0] - origin[0]) * (wall.end[0] - wall.start[0]) + (wall.start[1] - origin[1]) * (wall.end[1] - wall.start[1])) / length;
  const [rightStart, rightEnd, leftEnd, leftStart] = outline.corners;
  const from = along + Math.max(rightStart[0], leftStart[0]);
  const to = along + Math.min(rightEnd[0], leftEnd[0]);
  return boxes.every((box) => box.min[0] >= from - 1e-6 && box.max[0] <= to + 1e-6);
}

function slabLikeSet(reading: Reading, id: number, isRoof: boolean): QuantitySet | null {
  const { dataStore, view, editor, scale } = reading;
  const chain = resolveSlabEditChain(dataStore, view, editor, id, scale);
  // A tilted extrusion has no plan area to report as its own; the builders never write one.
  // A slab turned in plan is still upright, and its outline and openings share its own axes.
  if (!chain || (chain.baseElevation === null && !uprightAfterTurn(reading, id, chain.extrudedSolidId))) return null;
  const area = polygonArea(chain.footprint);
  // The footprint is storey-local with the placement origin added; an opening's box is in the host's frame.
  const local = chain.footprint.map(([x, y]) => [x - chain.placementOrigin[0], y - chain.placementOrigin[1]] as [number, number]);
  const boxes = openingBoxes(reading, id);
  const body = boxes && (boxes.length === 0 ? null : hostBox(reading, id));
  const readable = boxes !== null && (boxes.length === 0 || body !== null);
  // An opening clear of the body, above or below it, cuts nothing even where its plan overlaps.
  const cuts = readable ? boxes.map((box) => ({ area: clippedPolygonArea(local, box), depth: body ? axisOverlap(box, body, 2) : 0 }))
    .filter((cut) => cut.area > 0 && cut.depth > 0) : [];
  const netArea = readable ? Math.max(0, area - cuts.reduce((sum, cut) => sum + cut.area, 0)) : null;
  if (isRoof) {
    const rows: Row[] = [['GrossArea', QuantityType.Area, area], ['ProjectedArea', QuantityType.Area, area]];
    if (netArea !== null) rows.push(['NetArea', QuantityType.Area, netArea]);
    return toQuantitySet(dataStore, scale, 'Qto_RoofBaseQuantities', rows);
  }
  const rows: Row[] = [['Width', QuantityType.Length, chain.thickness]];
  if (chain.profileKind === 'rectangle') {
    // Length and Depth are the rectangle's two sides, read off its edges so a turned solid keeps them;
    // the schema gives them only for a rectangle.
    const [a, b, c] = local;
    rows.push(['Length', QuantityType.Length, Math.hypot(b[0] - a[0], b[1] - a[1])], ['Depth', QuantityType.Length, Math.hypot(c[0] - b[0], c[1] - b[1])]);
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

/** Whether a slab the plan readers refuse for its turn about the vertical is otherwise upright. */
function uprightAfterTurn(reading: Reading, id: number, solidId: number): boolean {
  const { dataStore, view, editor } = reading;
  const placement = resolvePlacementChain(dataStore, view, editor, id);
  const solid = readAttributes(dataStore, view, editor, solidId);
  const depth = solid?.[3];
  return !!placement && !!solid && typeof depth === 'number'
    && slabExtrusionFrame(dataStore, view, editor, placement.axisPlacementId, solid, depth, true) !== null;
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
  // A box overlap is the material cut only for a solid rectangle: beside an I's web it cuts air.
  if (boxes && (boxes.length === 0 || (body && (chain.profile === null || chain.profile.Type === 'Rectangle')))) {
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
    if (set) {
      const globalId = setGlobalId(reading, expressId, set.name);
      sets = [globalId ? { ...set, globalId } : set];
    }
  } catch (error) {
    console.warn(`[quantities] #${expressId} has no base quantities: its geometry could not be read`, error);
  }
  revision.sets.set(expressId, sets);
  return sets;
}
