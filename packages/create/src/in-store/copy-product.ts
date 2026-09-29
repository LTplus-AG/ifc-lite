/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Copy a product, turned and moved, onto its own storey or another one
 * (#6232 C3, decision D7): the one write behind the Model workspace's paste
 * and array, built on `duplicateInStore`.
 *
 *   - Every copy gets fresh GlobalIds (the product, its placement's rels).
 *   - The openings that void the product and the doors and windows that fill
 *     them are copied with it, and the IfcRelVoidsElement / IfcRelFillsElement
 *     are written again between the copies. One placed relative to its host
 *     (or its opening) keeps its local placement under the copy's.
 *   - A shape created this session is copied record by record (with the
 *     styles on its items), so the copy can be reshaped on its own. A shape
 *     read from the file is shared by reference, as Duplicate has always
 *     done.
 *
 * The turn and move are storey-local metres: a turn counter-clockwise about
 * the vertical through `pivot`, then `offset`. On another storey the copy is
 * placed relative to that storey's placement at the same plan position and
 * height above the floor.
 */

import { iterateEffectiveEntityIds, type IfcAttributeValue, type StoreEditor } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import { generateIfcGuid, type RandomSource } from '@ifc-lite/encoding';
import { duplicateInStore, type SourceAttributes } from './duplicate.js';
import { resolveDuplicateSource } from './resolve-source.js';
import { asRef, createStyleEntityReader, indexExistingStyles, refList } from './style-entity-reader.js';
import {
  IDENTITY_FRAME, applyRigid, composeRigid, frameInAncestor, invertRigid, readOwnPlacement,
  refToken, remapRefs, turnDirection, turnThenMove,
  type CopyVec3, type LiveRead, type RigidFrame,
} from './copy-frame.js';

export interface CopyTransform {
  /** Move after the turn, storey-local metres (IFC Z-up). */
  readonly offset?: readonly [number, number, number];
  /** Counter-clockwise turn about the vertical, radians. */
  readonly turn?: number;
  /** The plan point the turn is about, storey-local metres. Default: the storey origin. */
  readonly pivot?: readonly [number, number];
  /** The storey the copy goes on. Default: the source's own. */
  readonly targetStoreyId?: number;
}

export interface CopyProductResult {
  /** The copy of the product itself. */
  readonly copyId: number;
  readonly openingIds: readonly number[];
  readonly fillingIds: readonly number[];
  /** The storey the copy (and its doors and windows) is contained in. */
  readonly storeyId: number | null;
  /** Every element the copy wrote with a shape to mesh: the copy and its doors and windows. */
  readonly meshed: readonly number[];
}

/** Classes that are copied with their host, never on their own. */
const HOSTED_TYPES = new Set(['IFCOPENINGELEMENT', 'IFCOPENINGSTANDARDCASE', 'IFCVOIDINGFEATURE']);
const SPATIAL_TYPES = new Set(['IFCSPACE', 'IFCBUILDINGSTOREY', 'IFCBUILDING', 'IFCSITE', 'IFCSPATIALZONE', 'IFCEXTERNALSPATIALELEMENT', 'IFCPROJECT']);
/** A shape bigger than this is not deep-copied (a pathological overlay graph). */
const MAX_CLONED_SHAPE_RECORDS = 50_000;

interface HostedLink { readonly id: number; readonly ownerHistory: string | null }

/**
 * Everything one batch of copies reads once: the live reader, the styles and
 * the void / fill links of the model as it was before the batch.
 */
export interface CopyContext {
  readonly store: IfcDataStore;
  readonly editor: StoreEditor;
  readonly read: LiveRead;
  readonly guidRandom?: RandomSource;
  readonly styledBy: ReadonlyMap<number, number>;
  readonly voids: ReadonlyMap<number, readonly HostedLink[]>;
  readonly fills: ReadonlyMap<number, readonly HostedLink[]>;
  /** Fillings (door / window id → opening id). */
  readonly filledBy: ReadonlyMap<number, number>;
}

export function createCopyContext(store: IfcDataStore, editor: StoreEditor, options: { guidRandom?: RandomSource } = {}): CopyContext {
  const read = createStyleEntityReader(store, editor);
  const view = editor.getMutationView();
  const links = (relType: string) => {
    const out = new Map<number, HostedLink[]>();
    for (const { expressId } of iterateEffectiveEntityIds(store, view, [relType])) {
      const rel = read(expressId);
      const relating = asRef(rel?.attributes[4]);
      const related = asRef(rel?.attributes[5]);
      if (relating === null || related === null) continue;
      const list = out.get(relating) ?? [];
      list.push({ id: related, ownerHistory: refToken(asRef(rel?.attributes[1])) });
      out.set(relating, list);
    }
    return out;
  };
  const fills = links('IFCRELFILLSELEMENT');
  const filledBy = new Map<number, number>();
  for (const [opening, list] of fills) for (const { id } of list) filledBy.set(id, opening);
  return {
    store, editor, read, guidRandom: options.guidRandom,
    styledBy: indexExistingStyles(store, editor, read),
    voids: links('IFCRELVOIDSELEMENT'),
    fills,
    filledBy,
  };
}

/** Why `sourceId` cannot be copied on its own, or null when it can. */
export function copyRefusal(ctx: CopyContext, sourceId: number): string | null {
  const type = ctx.read(sourceId)?.type.toUpperCase();
  if (!type) return `#${sourceId} is not in the model`;
  if (HOSTED_TYPES.has(type)) return 'An opening is copied with the element it is cut into: copy that element';
  if (ctx.filledBy.has(sourceId)) return 'A door or window is copied with its wall: copy the wall';
  if (SPATIAL_TYPES.has(type)) return 'Spaces and spatial structure are not copied: copy the elements';
  return null;
}

export function copyProductInStore(ctx: CopyContext, sourceId: number, transform: CopyTransform = {}): CopyProductResult {
  const refusal = copyRefusal(ctx, sourceId);
  if (refusal) throw new Error(refusal);
  const source = resolveDuplicateSource(ctx.store, sourceId, ctx.editor);
  const scale = source.lengthUnitScale && source.lengthUnitScale > 0 ? source.lengthUnitScale : 1;
  const native = (m: number) => m / scale;
  const [ox, oy, oz] = transform.offset ?? [0, 0, 0];
  const [px, py] = transform.pivot ?? [0, 0];
  const move = turnThenMove(transform.turn ?? 0, [native(px), native(py)], [native(ox), native(oy), native(oz)]);

  const targetStoreyId = transform.targetStoreyId ?? source.storeyId;
  const placed = placeOnStorey(ctx.read, source, targetStoreyId, move);
  const copy = writeCopy(ctx, source, placed, targetStoreyId);

  // Openings and their doors and windows follow the host.
  const placements = new Map([[source.placementExpressId, copy.placementId]]);
  const openingIds: number[] = [];
  const fillingIds: number[] = [];
  for (const opening of ctx.voids.get(sourceId) ?? []) {
    const openingSource = resolveDuplicateSource(ctx.store, opening.id, ctx.editor);
    const openingCopy = writeCopy(ctx, openingSource, follow(ctx.read, openingSource, source, targetStoreyId, placements, move), null);
    placements.set(openingSource.placementExpressId, openingCopy.placementId);
    relate(ctx, 'IfcRelVoidsElement', opening.ownerHistory, copy.id, openingCopy.id);
    openingIds.push(openingCopy.id);
    for (const filling of ctx.fills.get(opening.id) ?? []) {
      const fillingSource = resolveDuplicateSource(ctx.store, filling.id, ctx.editor);
      const fillingCopy = writeCopy(ctx, fillingSource, follow(ctx.read, fillingSource, source, targetStoreyId, placements, move), targetStoreyId);
      placements.set(fillingSource.placementExpressId, fillingCopy.placementId);
      relate(ctx, 'IfcRelFillsElement', filling.ownerHistory, openingCopy.id, fillingCopy.id);
      fillingIds.push(fillingCopy.id);
    }
  }
  return { copyId: copy.id, openingIds, fillingIds, storeyId: targetStoreyId, meshed: [copy.id, ...fillingIds] };
}

/** Where a copy sits: its parent placement and its own placement in that parent. */
interface Placed {
  readonly parentPlacementId: number | null;
  readonly location: CopyVec3;
  /** The turn to apply to the source's Axis and RefDirection. */
  readonly turn: RigidFrame;
}

function storeyPlacementId(read: LiveRead, storeyId: number | null): number | null {
  return storeyId === null ? null : asRef(read(storeyId)?.attributes[5]);
}

function placeOnStorey(read: LiveRead, source: SourceAttributes, targetStoreyId: number | null, move: RigidFrame): Placed {
  const own = readOwnPlacement(read, source.placementExpressId);
  if (!own) throw new Error(`#${source.placementExpressId}: the placement does not read as a local placement`);
  const fromStorey = storeyPlacementId(read, source.storeyId);
  // The parent's frame in the storey's; a parent the walk cannot tie to the
  // storey is taken as storey-aligned, as a move of the element takes it.
  const parent = fromStorey === null ? IDENTITY_FRAME : frameInAncestor(read, source.parentPlacementId, fromStorey);
  if (targetStoreyId === source.storeyId) {
    const frame = parent ?? IDENTITY_FRAME;
    const location = applyRigid(invertRigid(frame), applyRigid(move, applyRigid(frame, own.location)));
    return { parentPlacementId: source.parentPlacementId, location, turn: move };
  }
  const toStorey = storeyPlacementId(read, targetStoreyId);
  if (!parent || toStorey === null) {
    throw new Error(`#${source.placementExpressId}: only an element placed on its storey can be copied to another storey`);
  }
  // Same plan position and height above the floor, now under the other storey's placement.
  return { parentPlacementId: toStorey, location: applyRigid(move, applyRigid(parent, own.location)), turn: composeRigid(move, parent) };
}

/**
 * A hosted element: under the copy of the placement it was placed relative
 * to, unchanged; otherwise moved as its host was, on the host's storey (an
 * opening is not contained in one of its own).
 */
function follow(
  read: LiveRead,
  source: SourceAttributes,
  host: SourceAttributes,
  targetStoreyId: number | null,
  placements: ReadonlyMap<number, number>,
  move: RigidFrame,
): Placed {
  const mapped = source.parentPlacementId === null ? undefined : placements.get(source.parentPlacementId);
  if (mapped !== undefined) return { parentPlacementId: mapped, location: [...source.sourceLocation], turn: IDENTITY_FRAME };
  return placeOnStorey(read, { ...source, storeyId: host.storeyId }, targetStoreyId, move);
}

function writeCopy(ctx: CopyContext, source: SourceAttributes, placed: Placed, storeyId: number | null): { id: number; placementId: number } {
  const turned = Math.abs(placed.turn.s) > 1e-12 || placed.turn.c < 0;
  const own = turned ? readOwnPlacement(ctx.read, source.placementExpressId) : null;
  const direction = (v: CopyVec3 | null, fallback: CopyVec3 | null): string | null => {
    const base = v ?? fallback;
    if (!base) return null;
    return `#${ctx.editor.addEntity('IfcDirection', [turnDirection(placed.turn, base)]).expressId}`;
  };
  const attributes = [...source.attributes];
  const shape = cloneCreatedShape(ctx, source.representationId);
  if (shape !== null) attributes[6] = `#${shape}`;
  const built = duplicateInStore(ctx.editor, {
    ...source,
    attributes,
    sourceLocation: placed.location,
    parentPlacementId: placed.parentPlacementId,
    storeyId,
    // An upright Axis does not change under a turn about the vertical.
    axisRef: own && own.axis && (Math.abs(own.axis[0]) > 1e-12 || Math.abs(own.axis[1]) > 1e-12) ? direction(own.axis, null) : source.axisRef,
    refDirectionRef: own ? direction(own.refDirection, [1, 0, 0]) : source.refDirectionRef,
    lengthUnitScale: 1,
  }, {
    offset: [0, 0, 0],
    // A copy is the same element again: it keeps the source's Name.
    name: typeof source.attributes[2] === 'string' ? source.attributes[2] : undefined,
    guidRandom: ctx.guidRandom,
  });
  return { id: built.newId, placementId: built.newPlacementId };
}

function relate(ctx: CopyContext, type: 'IfcRelVoidsElement' | 'IfcRelFillsElement', ownerHistory: string | null, relating: number, related: number): void {
  ctx.editor.addEntity(type, [generateIfcGuid(ctx.guidRandom), ownerHistory, null, null, `#${relating}`, `#${related}`]);
}

/**
 * Copy a shape created this session, record by record, with the styles on
 * its items; null when the shape is the file's own (it is then shared).
 * Records the file holds (a representation context) stay shared references.
 */
function cloneCreatedShape(ctx: CopyContext, shapeId: number | null): number | null {
  const view = ctx.editor.getMutationView();
  const created = (id: number) => view.getNewEntity(id) !== null && !view.isDeleted(id);
  if (shapeId === null || !created(shapeId)) return null;
  const copies = new Map<number, number>();
  const expanded = new Set<number>();
  // Iterative post-order: children are written before the records that name them.
  const stack = [shapeId];
  while (stack.length > 0) {
    const id = stack[stack.length - 1];
    const record = copies.has(id) ? null : ctx.read(id);
    if (!record) { stack.pop(); continue; }
    if (!expanded.has(id)) {
      expanded.add(id);
      if (expanded.size > MAX_CLONED_SHAPE_RECORDS) throw new Error(`The shape of this element is too large to copy (over ${MAX_CLONED_SHAPE_RECORDS} records)`);
      for (const child of childRefs(record.attributes)) if (created(child) && !expanded.has(child)) stack.push(child);
      continue;
    }
    stack.pop();
    copies.set(id, ctx.editor.addEntity(record.type, record.attributes.map((a) => remapRefs(a, copies))).expressId);
  }
  for (const [from, to] of copies) {
    const styledItem = ctx.styledBy.get(from);
    const style = styledItem === undefined ? null : ctx.read(styledItem);
    // IfcStyledItem(Item, Styles, Name): the same styles, on the copied item.
    if (style) ctx.editor.addEntity('IfcStyledItem', [`#${to}`, refList(style.attributes[1]).map((id) => `#${id}`), (style.attributes[2] ?? null) as IfcAttributeValue]);
  }
  return copies.get(shapeId) ?? null;
}

function childRefs(values: readonly unknown[]): number[] {
  const out: number[] = [];
  const visit = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (typeof value === 'string') {
      const id = asRef(value);
      if (id !== null) out.push(id);
    }
  };
  values.forEach(visit);
  return out;
}

/**
 * Where a product's placement origin is on its storey, metres: the point a
 * paste lines up with the cursor. Null when its placement does not read.
 */
export function productStoreyOrigin(ctx: CopyContext, id: number): { storeyId: number | null; origin: CopyVec3 } | null {
  let source: SourceAttributes;
  try {
    source = resolveDuplicateSource(ctx.store, id, ctx.editor);
  } catch (error) {
    console.warn(`[create] #${id} has no readable placement to copy from`, error);
    return null;
  }
  const own = readOwnPlacement(ctx.read, source.placementExpressId);
  if (!own) return null;
  const fromStorey = storeyPlacementId(ctx.read, source.storeyId);
  const parent = (fromStorey === null ? null : frameInAncestor(ctx.read, source.parentPlacementId, fromStorey)) ?? IDENTITY_FRAME;
  const scale = source.lengthUnitScale && source.lengthUnitScale > 0 ? source.lengthUnitScale : 1;
  const [x, y, z] = applyRigid(parent, own.location);
  return { storeyId: source.storeyId, origin: [x * scale, y * scale, z * scale] };
}
