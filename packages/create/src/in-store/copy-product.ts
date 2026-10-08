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
import { copyDependentSteps, copiedProductWork } from './copy-dependent-walk.js';
import { asRef, createStyleEntityReader, indexExistingStyles, refList } from './style-entity-reader.js';
import {
  IDENTITY_FRAME, applyRigid, composeRigid, frameInAncestor, invertRigid, readOwnPlacement,
  refToken, remapRefs, turnDirection, turnThenMove, finiteCopyFrame,
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
  /** The copies of the assembly's parts, at every depth. */
  readonly partIds: readonly number[];
  /** Source product id for every copied product, including openings, fillings and assembly parts. */
  readonly copiedFrom: ReadonlyMap<number, number>;
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

/** One IfcRelAggregates: the parts of an assembly, and the rel's OwnerHistory. */
interface PartsLink { readonly ownerHistory: string | null; readonly parts: readonly number[] }

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
  /** Assembly id → its IfcRelAggregates parts (a spatial container's children are not parts). */
  readonly parts: ReadonlyMap<number, readonly PartsLink[]>;
  /** Part id → its assembly. */
  readonly partOf: ReadonlyMap<number, number>;
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
  const parts = new Map<number, PartsLink[]>();
  const partOf = new Map<number, number>();
  for (const { expressId } of iterateEffectiveEntityIds(store, view, ['IFCRELAGGREGATES'])) {
    const rel = read(expressId);
    const whole = asRef(rel?.attributes[4]);
    const wholeType = whole === null ? undefined : read(whole)?.type.toUpperCase();
    if (whole === null || !wholeType || SPATIAL_TYPES.has(wholeType)) continue;
    const related = refList(rel?.attributes[5]);
    if (related.length === 0) continue;
    const list = parts.get(whole) ?? [];
    list.push({ ownerHistory: refToken(asRef(rel?.attributes[1])), parts: related });
    parts.set(whole, list);
    for (const part of related) partOf.set(part, whole);
  }
  return {
    store, editor, read, guidRandom: options.guidRandom,
    styledBy: indexExistingStyles(store, editor, read),
    voids: links('IFCRELVOIDSELEMENT'),
    fills,
    filledBy,
    parts,
    partOf,
  };
}

/** Why `sourceId` cannot be copied on its own, or null when it can. */
export function copyRefusal(ctx: CopyContext, sourceId: number): string | null {
  const type = ctx.read(sourceId)?.type.toUpperCase();
  if (!type) return `#${sourceId} is not in the model`;
  if (HOSTED_TYPES.has(type)) return 'An opening is copied with the element it is cut into: copy that element';
  if (ctx.filledBy.has(sourceId)) return 'A door or window is copied with its wall: copy the wall';
  if (ctx.partOf.has(sourceId)) return 'A part is copied with its assembly: copy the assembly';
  if (SPATIAL_TYPES.has(type)) return 'Spaces and spatial structure are not copied: copy the elements';
  return null;
}

/** Copy the complete product graph. `options.Name` overrides only the root product’s Name. */
export function copyProductInStore(ctx: CopyContext, sourceId: number, transform: CopyTransform = {}, options: { Name?: string } = {}): CopyProductResult {
  const refusal = copyRefusal(ctx, sourceId);
  if (refusal) throw new Error(refusal);
  copiedProductWork(ctx, sourceId);
  const source = resolveDuplicateSource(ctx.store, sourceId, ctx.editor);
  const scale = source.lengthUnitScale && source.lengthUnitScale > 0 ? source.lengthUnitScale : 1;
  const native = (m: number) => m / scale;
  const [ox, oy, oz] = transform.offset ?? [0, 0, 0];
  const [px, py] = transform.pivot ?? [0, 0];
  const move = finiteCopyFrame(turnThenMove(transform.turn ?? 0, [native(px), native(py)], [native(ox), native(oy), native(oz)]));

  const targetStoreyId = transform.targetStoreyId ?? source.storeyId;
  const placed = placeOnStorey(ctx.read, source, targetStoreyId, move);
  const copy = writeCopy(ctx, source, placed, targetStoreyId, options.Name);

  // Openings, their doors and windows, and the parts of an assembly follow it.
  const acc: Dependents = { placements: new Map([[source.placementExpressId, copy.placementId]]), openingIds: [], fillingIds: [], partIds: [], copiedFrom: new Map([[copy.id, sourceId]]) };
  copyDependents(ctx, sourceId, copy.id, source, targetStoreyId, move, acc);
  return {
    copyId: copy.id, openingIds: acc.openingIds, fillingIds: acc.fillingIds, partIds: acc.partIds, storeyId: targetStoreyId,
    meshed: [copy.id, ...acc.partIds, ...acc.fillingIds], copiedFrom: acc.copiedFrom,
  };
}

interface Dependents {
  /** Source placement → its copy, so a hosted element keeps its place under the copy's. */
  readonly placements: Map<number, number>;
  readonly openingIds: number[];
  readonly fillingIds: number[];
  readonly partIds: number[];
  readonly copiedFrom: Map<number, number>;
}

/** The copies of `sourceId`'s openings (with their doors and windows) and parts (recursively), written under `copyId`. */
function copyDependents(ctx: CopyContext, sourceId: number, copyId: number, root: SourceAttributes, targetStoreyId: number | null, move: RigidFrame, acc: Dependents): void {
  const copies = new Map([[sourceId, copyId]]);
  for (const step of copyDependentSteps(ctx, sourceId)) {
    if (step.kind === 'assembly') {
      if (step.parts.length > 0) ctx.editor.addEntity('IfcRelAggregates', [generateIfcGuid(ctx.guidRandom), step.ownerHistory, null, null,
        `#${copies.get(step.sourceId)!}`, step.parts.map(id => `#${copies.get(id)!}`)]);
      continue;
    }
    const parentCopy = copies.get(step.parentId)!;
    const source = resolveDuplicateSource(ctx.store, step.sourceId, ctx.editor);
    const copy = writeCopy(ctx, source, follow(ctx.read, source, root, targetStoreyId, acc.placements, move), step.kind === 'filling' ? targetStoreyId : null);
    acc.placements.set(source.placementExpressId, copy.placementId);
    acc.copiedFrom.set(copy.id, step.sourceId); copies.set(step.sourceId, copy.id);
    if (step.kind === 'part') acc.partIds.push(copy.id);
    else if (step.kind === 'opening') {
      relate(ctx, 'IfcRelVoidsElement', step.ownerHistory, parentCopy, copy.id);
      acc.openingIds.push(copy.id);
    } else {
      relate(ctx, 'IfcRelFillsElement', step.ownerHistory, parentCopy, copy.id);
      acc.fillingIds.push(copy.id);
    }
  }
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

/**
 * The source's parent placement as a frame in its storey's. A storey without a
 * placement has no frame to tie to (the storey plane is then the model frame).
 * A parent that does not chain to the storey's placement has no known place on
 * the storey, so the copy is refused: the preview (`copy-ghost.ts`) works in
 * the storey's frame, and a guess here would commit the copy somewhere else.
 */
function parentFrameInStorey(read: LiveRead, source: SourceAttributes, fromStorey: number | null): RigidFrame {
  if (fromStorey === null) return IDENTITY_FRAME;
  const parent = frameInAncestor(read, source.parentPlacementId, fromStorey);
  if (!parent) throw new Error(`#${source.placementExpressId}: its placement is not tied to its storey's, so it cannot be copied`);
  return parent;
}

function placeOnStorey(read: LiveRead, source: SourceAttributes, targetStoreyId: number | null, move: RigidFrame): Placed {
  const own = readOwnPlacement(read, source.placementExpressId);
  if (!own) throw new Error(`#${source.placementExpressId}: the placement does not read as a local placement`);
  const fromStorey = storeyPlacementId(read, source.storeyId);
  const parent = parentFrameInStorey(read, source, fromStorey);
  if (targetStoreyId === source.storeyId) {
    const location = applyRigid(invertRigid(parent), applyRigid(move, applyRigid(parent, own.location)));
    return { parentPlacementId: source.parentPlacementId, location, turn: move };
  }
  const toStorey = storeyPlacementId(read, targetStoreyId);
  if (toStorey === null) {
    throw new Error(`#${source.placementExpressId}: the storey it is copied to has no placement to copy under`);
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

function writeCopy(ctx: CopyContext, source: SourceAttributes, placed: Placed, storeyId: number | null, name?: string): { id: number; placementId: number } {
  if (![...placed.location, ...placed.turn.origin, placed.turn.c, placed.turn.s].every(Number.isFinite)) throw new Error('Copy placement must remain finite in native model units');
  const turned = Math.abs(placed.turn.s) > 1e-12 || placed.turn.c < 0;
  const own = turned ? readOwnPlacement(ctx.read, source.placementExpressId) : null;
  const direction = (v: CopyVec3 | null, fallback: CopyVec3 | null): string | null => {
    const base = v ?? fallback;
    if (!base) return null;
    const moved = turnDirection(placed.turn, base);
    if (!moved.every(Number.isFinite)) throw new Error('Copy direction must remain finite in native model units');
    return `#${ctx.editor.addEntity('IfcDirection', [moved]).expressId}`;
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
    name: name ?? (typeof source.attributes[2] === 'string' ? source.attributes[2] : undefined),
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
 * paste lines up with the cursor. Null when its placement does not read;
 * throws (with the reason) when it is not tied to its storey, as a copy would.
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
  const parent = parentFrameInStorey(ctx.read, source, fromStorey);
  const scale = source.lengthUnitScale && source.lengthUnitScale > 0 ? source.lengthUnitScale : 1;
  const [x, y, z] = applyRigid(parent, own.location);
  return { storeyId: source.storeyId, origin: [x * scale, y * scale, z * scale] };
}
