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
 * height above the floor. Where a copy goes is `copy-placement.ts`, including
 * one of an element on a grid: on the crossing it lands on, or free (#9199).
 */

import { cloneEffectiveMetadata } from './edit/metadata-clone-effective.js';
import { iterateEffectiveEntityIds, type IfcAttributeValue, type StoreEditor } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import { generateIfcGuid, type RandomSource } from '@ifc-lite/encoding';
import { duplicateInStore, type SourceAttributes } from './duplicate.js';
import { resolveDuplicateSource } from './resolve-source.js';
import { copyDependentSteps, copiedProductWork } from './copy-dependent-walk.js';
import { follow, gridCopyRefusal, placeOnStorey, type Placed } from './copy-placement.js';
import { asRef, createStyleEntityReader, indexExistingStyles, refList } from './style-entity-reader.js';
import {
  readOwnPlacement, refToken, remapRefs, turnDirection, turnThenMove, finiteCopyFrame,
  type CopyVec3, type LiveRead, type RigidFrame,
} from './copy-frame.js';

import { readCopyAttachments, rebindCopiedAttachments, withUnattachedTops, type CopyUnattachedTop } from './copy-attachment.js';

export { productStoreyOrigin } from './copy-placement.js';

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
  /** Copied child → copied parent, including nested assemblies and hosted dependents. */
  readonly carriedBy?: ReadonlyMap<number, number>;
  /** The storey the copy (and its doors and windows) is contained in. */
  readonly storeyId: number | null;
  /** Every element the copy wrote with a shape to mesh: the copy and its doors and windows. */
  readonly meshed: readonly number[];
  /**
   * Copies that found their own place on the grid and bound to the crossing they
   * landed on. A part or opening placed under a copied placement follows that
   * copy and is not listed: it is not a second copy to tell anyone about.
   */
  readonly boundToGrid: readonly number[];
  /** Copies that found their own place on the grid and landed on no crossing, now free of it. Listed as {@link boundToGrid}. */
  readonly cameFree: readonly number[];
  /**
   * Copies whose top attachment could not follow their new storey, left fixed
   * at the source's height, with the reason (`copy-attachment.ts`). Absent
   * when every attached copy followed.
   */
  readonly unattachedTops?: readonly CopyUnattachedTop[];
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

/** Why `sourceId` cannot be copied, or null when it can. Throws when what it carries is too large to walk. */
export function copyRefusal(ctx: CopyContext, sourceId: number): string | null {
  const source = ctx.read(sourceId);
  const type = source?.type.toUpperCase();
  if (!type) return 'This element is no longer in the model';
  if (HOSTED_TYPES.has(type)) return 'An opening is copied with the element it is cut into: copy that element';
  if (ctx.filledBy.has(sourceId)) return 'A door or window is copied with its wall: copy the wall';
  if (ctx.partOf.has(sourceId)) return 'A part is copied with its assembly: copy the assembly';
  if (SPATIAL_TYPES.has(type)) return 'Spaces and spatial structure are not copied: copy the elements';
  return gridCopyRefusal(ctx, sourceId);
}

/**
 * Copy the complete product graph. `options.Name` overrides only the root
 * product’s Name. A copy on another storey re-resolves its top attachment
 * there (`copy-attachment.ts`), as the batch does. The copy and the re-bind
 * are one atomic write: when either refuses, nothing is left behind (#9352).
 */
export function copyProductInStore(ctx: CopyContext, sourceId: number, transform: CopyTransform = {}, options: { Name?: string } = {}): CopyProductResult {
  return ctx.editor.runAtomic((draft) => {
    const inner: CopyContext = { ...ctx, editor: draft, read: createStyleEntityReader(ctx.store, draft) };
    const attachments = readCopyAttachments(inner, carriedParts(inner, sourceId));
    const result = copyProductGraph(inner, sourceId, transform, options);
    return withUnattachedTops([result], rebindCopiedAttachments(inner, attachments, [result]).unattached)[0];
  });
}

/** The product and every assembly part it carries, at every depth (iterative, visited set). */
function carriedParts(ctx: CopyContext, sourceId: number): number[] {
  const seen = new Set<number>();
  const pending = [sourceId];
  while (pending.length > 0) {
    const id = pending.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const link of ctx.parts.get(id) ?? []) pending.push(...link.parts);
  }
  return [...seen];
}

/**
 * `copyProductInStore` without the attachment step: for a batch, which reads
 * every source's attachment once before its first copy and re-binds each
 * transform's copies together (so a slab copied alongside is found).
 */
export function copyProductGraph(ctx: CopyContext, sourceId: number, transform: CopyTransform = {}, options: { Name?: string } = {}): CopyProductResult {
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
  const placed = placeOnStorey(ctx, source, targetStoreyId, move);
  const copy = writeCopy(ctx, source, placed, targetStoreyId, options.Name);

  // Openings, their doors and windows, and the parts of an assembly follow it.
  const acc: Dependents = { placements: new Map([[source.placementExpressId, copy.placementId]]), openingIds: [], fillingIds: [], partIds: [], copiedFrom: new Map([[copy.id, sourceId]]), carriedBy: new Map(), boundToGrid: [], cameFree: [] };
  noteGridOutcome(acc, placed, copy.id);
  copyDependents(ctx, sourceId, copy.id, source, targetStoreyId, move, acc);
  for (const [copiedId, originalId] of acc.copiedFrom) cloneEffectiveMetadata(ctx.editor.getMutationView(), ctx.editor, originalId, [copiedId]);
  return {
    copyId: copy.id, openingIds: acc.openingIds, fillingIds: acc.fillingIds, partIds: acc.partIds, storeyId: targetStoreyId,
    meshed: [copy.id, ...acc.partIds, ...acc.fillingIds], copiedFrom: acc.copiedFrom, carriedBy: acc.carriedBy,
    boundToGrid: acc.boundToGrid, cameFree: acc.cameFree,
  };
}

interface Dependents {
  /** Source placement → its copy, so a hosted element keeps its place under the copy's. */
  readonly placements: Map<number, number>;
  readonly openingIds: number[];
  readonly fillingIds: number[];
  readonly partIds: number[];
  readonly copiedFrom: Map<number, number>;
  readonly carriedBy: Map<number, number>;
  readonly boundToGrid: number[];
  readonly cameFree: number[];
}

function noteGridOutcome(acc: Dependents, placed: Placed, copyId: number): void {
  if (placed.grid === 'bound') acc.boundToGrid.push(copyId);
  else if (placed.grid === 'free') acc.cameFree.push(copyId);
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
    const placed = follow(ctx, source, root, targetStoreyId, acc.placements, move);
    const copy = writeCopy(ctx, source, placed, step.kind === 'filling' ? targetStoreyId : null);
    noteGridOutcome(acc, placed, copy.id);
    acc.placements.set(source.placementExpressId, copy.placementId);
    acc.carriedBy.set(copy.id, parentCopy);
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

function writeCopy(ctx: CopyContext, source: SourceAttributes, placed: Placed, storeyId: number | null, name?: string): { id: number; placementId: number } {
  if (![...placed.location, ...placed.turn.origin, placed.turn.c, placed.turn.s].every(Number.isFinite)) throw new Error('Copy placement must remain finite in native model units');
  const turned = Math.abs(placed.turn.s) > 1e-12 || placed.turn.c < 0;
  const own = turned ? placed.own ?? readOwnPlacement(ctx.read, source.placementExpressId) : null;
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
    // `placed` is where it goes, read through its grid placement when it has one.
    onGridPlacement: false,
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
