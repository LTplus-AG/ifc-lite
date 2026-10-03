/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Canonical atomic Room graph writes over the native DCEL's candidates (#6232 D5). */
import { editOwnershipRefusal } from '@ifc-lite/export';
import { QuantityType } from '@ifc-lite/data';
import { getSchemaRegistryForVersion, type IfcDataStore } from '@ifc-lite/parser';
import type { StoreEditor } from '@ifc-lite/mutations';
import { addSpaceToStore } from './space.js';
import { GENERATED_SPACE_OBJECTTYPE } from './generate-spaces.js';
import { resolveSpatialAnchor } from './resolve-anchor.js';
import { resolveSplitTarget, type SlabSplitChain } from './edit/split-target.js';
import { getModelLengthUnitScale } from './edit/length-unit-scale.js';
import { effectiveStoreyId } from './edit/effective-storey.js';
import { emitClippedProfile } from './element-split-slab.js';
import { readAttributes } from './edit/placement-core.js';
import { cloneElementMetadata } from './edit/metadata-clone.js';
import { deriveSplitGlobalId, globalIdTakenIn, keepsFirstPiece, type GlobalIdScope } from './edit/split-guid.js';
import { polygonArea as polyArea, pointInPolygon as pointInPoly } from './room-footprint-offset.js';
import { roomAt, interiorPoint, roomOutline, type RoomBoundary, type RoomCandidate, type RoomLink } from './room-candidates.js';
import type { LayoutFace, Pt } from './room-layout-core.js';

export interface NewRoom {
  outline: Pt[];
  height: number;
  z: number;
  Name: string;
  PredefinedType?: string;
  ObjectType?: string;
  grossArea: number;
  netArea: number;
  derived: boolean;
}
export type RoomChain = SlabSplitChain;
export type RoomRewrite = { ok: true; storeyId: number; chain: RoomChain } | { ok: false; reason: 'shape' | 'storey' };
export type RoomUpdate = { ok: true; outline: Pt[] } | { ok: false; reason: 'shape' | 'storey' | 'noRoom' };
export interface LayoutSync { created: number[]; deleted: number[]; remesh: number[] }

/** Source and overlay use the exact same supported extrusion predicate. */
export function roomChainInStore(store: IfcDataStore, editor: StoreEditor, id: number): RoomRewrite {
  const view = editor.getMutationView();
  const target = resolveSplitTarget(store, view, editor, id, getModelLengthUnitScale(store));
  if (!target.ok) return { ok: false, reason: target.code === 'storey' || target.code === 'container' ? 'storey' : 'shape' };
  if (target.kind !== 'slab' || target.chain.elementType !== 'IfcSpace') return { ok: false, reason: 'shape' };
  const storeyId = effectiveStoreyId(store, view, id);
  return storeyId === undefined ? { ok: false, reason: 'storey' } : { ok: true, storeyId, chain: target.chain };
}

/** Auto/pick/draw commit their supplied native outlines together as one operation. */
export function createRoomsInStore(store: IfcDataStore, editor: StoreEditor, storeyId: number, rooms: readonly NewRoom[]): number[] {
  if (rooms.length > 10000) throw new Error('Room batch exceeds 10000 rooms');
  return editor.runAtomic(draft => {
    const anchor = resolveSpatialAnchor(store, storeyId, draft.getMutationView());
    return rooms.map(room => addSpaceToStore(draft, anchor, {
      Profile: 'polygon', OuterCurve: room.outline, Position: [0, 0, room.z], Height: room.height, Name: room.Name,
      ...(room.PredefinedType !== undefined ? { PredefinedType: room.PredefinedType } : {}),
      ...(room.ObjectType ? { ObjectType: room.ObjectType } : room.derived ? { ObjectType: GENERATED_SPACE_OBJECTTYPE } : {}),
      grossFloorArea: room.grossArea, netFloorArea: room.netArea,
    }).spaceId);
  });
}

export function setRoomAreasInStore(editor: StoreEditor, id: number, areas: { grossArea: number; netArea: number }, height: number): void {
  const view = editor.getMutationView(), qto = 'Qto_SpaceBaseQuantities';
  view.setQuantity(id, qto, 'GrossFloorArea', areas.grossArea, QuantityType.Area);
  view.setQuantity(id, qto, 'NetFloorArea', areas.netArea, QuantityType.Area);
  view.setQuantity(id, qto, 'GrossVolume', areas.grossArea * height, QuantityType.Volume);
}

/** Preserve root identity, placement, metadata and links while replacing only its profile. */
export function rewriteRoomOutlineInStore(store: IfcDataStore, editor: StoreEditor, id: number, chain: RoomChain, outline: readonly Pt[], areas: { grossArea: number; netArea: number }): void {
  const ownership = editOwnershipRefusal(store, editor.getMutationView(), [chain.extrudedSolidId], new Set([id]));
  if (ownership) throw new Error(ownership);
  const origin = chain.placementOrigin;
  const emitted = emitClippedProfile(editor, outline, origin, chain.baseElevation - origin[2], getModelLengthUnitScale(store));
  editor.setPositionalAttribute(chain.extrudedSolidId, 0, `#${emitted.profile}`);
  editor.setPositionalAttribute(chain.extrudedSolidId, 1, `#${emitted.solidPosition}`);
  editor.setPositionalAttribute(chain.extrudedSolidId, 2, `#${emitted.up}`);
  setRoomAreasInStore(editor, id, areas, chain.thickness);
}

export function updateRoomOutlineInStore(store: IfcDataStore, editor: StoreEditor, id: number, boundary: RoomBoundary, roomsOn: (storeyId: number) => readonly RoomCandidate[]): RoomUpdate {
  return editor.runAtomic(draft => {
    const target = roomChainInStore(store, draft, id);
    if (!target.ok) return target;
    const room = roomAt(roomsOn(target.storeyId), interiorPoint(target.chain.footprint));
    if (!room) return { ok: false, reason: 'noRoom' };
    const outline = roomOutline(room, boundary);
    rewriteRoomOutlineInStore(store, draft, id, target.chain, outline, room);
    return { ok: true, outline };
  });
}

function dropCollinear(ring: readonly Pt[]): Pt[] {
  const out = ring.filter((p, i) => {
    const a = ring[(i + ring.length - 1) % ring.length], b = ring[(i + 1) % ring.length];
    const cross = (p[0] - a[0]) * (b[1] - a[1]) - (p[1] - a[1]) * (b[0] - a[0]);
    return Math.abs(cross) > 1e-9 * Math.max(1, Math.hypot(b[0] - a[0], b[1] - a[1]));
  });
  return out.length >= 3 ? out : [...ring];
}
const outlineOf = (face: LayoutFace, link: RoomLink) => dropCollinear(roomOutline(face, link.boundary));
const ringKey = (ring: readonly Pt[]) => ring.map(p => `${p[0].toFixed(4)},${p[1].toFixed(4)}`).join(';');
const areasOf = (face: LayoutFace) => ({ grossArea: polyArea(face.centre), netArea: polyArea(face.inner) });
function chainOf(store: IfcDataStore, editor: StoreEditor, id: number): RoomChain {
  const target = roomChainInStore(store, editor, id);
  if (!target.ok) throw new Error(`Room layout refuses unsupported ${target.reason} for #${id}`);
  return target.chain;
}
function faceHolding<F extends LayoutFace>(faces: readonly F[], p: Pt): F | null {
  let hit: F | null = null;
  for (const face of faces) if (pointInPoly(p[0], p[1], face.centre) && (!hit || polyArea(face.centre) < polyArea(hit.centre))) hit = face;
  return hit;
}

/** Native layout edit keeps the larger split/merged room identity and its metadata. */
export function syncRoomLayoutInStore(store: IfcDataStore, editor: StoreEditor, before: readonly RoomCandidate[], after: readonly LayoutFace[], globalIdScopes: readonly GlobalIdScope[] = []): LayoutSync {
  return editor.runAtomic(draft => {
    const out: LayoutSync = { created: [], deleted: [], remesh: [] }, view = draft.getMutationView();
    const pre = new Map(before.map(c => [c.face, c])), post = new Map(after.map(f => [f.face, f]));
    const removed = before.filter(c => !post.has(c.face)), handled = new Set<number>();
    for (const face of after) {
      if (pre.has(face.face)) continue;
      const parent = faceHolding(before, interiorPoint(face.inner.length >= 3 ? face.inner : face.centre));
      const kept = parent ? post.get(parent.face) : undefined;
      if (!parent?.room || !kept || handled.has(kept.face)) continue;
      const { room: link } = parent, chain = chainOf(store, draft, link.expressId);
      const keepFirst = keepsFirstPiece(polyArea(outlineOf(kept, link)), polyArea(outlineOf(face, link)));
      const [keptFace, cutFace] = keepFirst ? [kept, face] : [face, kept];
      const attrs = readAttributes(store, view, draft, link.expressId);
      if (!attrs) throw new Error('Room layout refuses unreadable source attributes');
      const classification = attrs[9];
      if (classification != null && typeof classification !== 'string') throw new Error('Room layout refuses invalid classification');
      const schema = store.schemaVersion;
      const registry = getSchemaRegistryForVersion(schema === 'IFC2X3' || schema === 'IFC4X3' ? schema : 'IFC4');
      if (classification == null && !registry.entities.IfcSpace.allAttributes![9].optional) throw new Error('Room layout requires source classification');
      const target = roomChainInStore(store, draft, link.expressId);
      if (!target.ok) throw new Error('Room layout requires a storey');
      const added = addSpaceToStore(draft, resolveSpatialAnchor(store, target.storeyId, view), {
        Profile: 'polygon', Position: [0, 0, chain.baseElevation], OuterCurve: outlineOf(cutFace, link), Height: chain.thickness,
        ...(typeof attrs[2] === 'string' ? { Name: attrs[2] } : {}),
        ...(typeof classification === 'string' ? { PredefinedType: classification.replace(/^\.|\.$/g, '') } : {}),
        ...(typeof attrs[4] === 'string' ? { ObjectType: attrs[4] } : {}),
        GlobalId: deriveSplitGlobalId(typeof attrs[0] === 'string' ? attrs[0] : String(link.expressId), globalIdTakenIn([{ dataStore: store, view }, ...globalIdScopes])),
      }).spaceId;
      if (classification == null) draft.setPositionalAttribute(added, 9, null);
      rewriteRoomOutlineInStore(store, draft, link.expressId, chain, outlineOf(keptFace, link), areasOf(keptFace));
      cloneElementMetadata(store, view, draft, link.expressId, [added]);
      setRoomAreasInStore(draft, added, areasOf(cutFace), chain.thickness);
      handled.add(kept.face).add(face.face);
      out.created.push(added); out.remesh.push(link.expressId, added);
    }
    for (const face of after) {
      if (handled.has(face.face)) continue;
      const own = pre.get(face.face), absorbed = removed.filter(r => pointInPoly(r.interior[0], r.interior[1], face.centre));
      const sources = [...(own ? [own] : []), ...absorbed];
      const links = [...new Map(sources.flatMap(c => c.room ? [[c.room.expressId, c.room] as const] : [])).values()];
      if (links.length === 0 || (absorbed.length === 0 && own && ringKey(own.centre) === ringKey(face.centre))) continue;
      const chains = links.map(link => ({ link, chain: chainOf(store, draft, link.expressId) }));
      chains.sort((x, y) => polyArea(y.chain.footprint) - polyArea(x.chain.footprint));
      const [{ link, chain }, ...merged] = chains;
      rewriteRoomOutlineInStore(store, draft, link.expressId, chain, outlineOf(face, link), areasOf(face));
      out.remesh.push(link.expressId);
      for (const entry of merged) {
        if (!draft.removeEntity(entry.link.expressId)) throw new Error('Room layout could not remove merged room');
        out.deleted.push(entry.link.expressId);
      }
    }
    return out;
  });
}
