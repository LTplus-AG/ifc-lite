/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A room layout edit, written to the rooms it touched (charter #6232 M4),
 * inside `room.place`'s transaction: one edit, one undo step.
 *
 * The plate keeps a face's id through an edit, so the faces before and after
 * say what happened to each room:
 *
 *   - a face that is still there with another outline (a dragged corner, a
 *     dissolved node): its room is rewritten in place;
 *   - a NEW face cut out of a room's face (a split): the room keeps the larger
 *     piece and a new room takes the other, under the split identity policy
 *     (`lib/split-guid.ts`: derived GlobalId, the source's name, psets and
 *     quantities), exactly as `element.split` splits a slab-like element;
 *   - a face that is GONE, absorbed into a neighbour (a merge): the larger
 *     of the rooms involved takes the merged outline, the others are deleted.
 *
 * Faces that are not rooms yet change as candidates only; nothing is written
 * for them. A room that is not a plan extrusion on a storey (a faceted file
 * space) refuses the edit, and the transaction rolls back.
 */

import type { ViewerState } from '@/store';
import { resolve as translate } from '@/i18n/registry';
import { keepsFirstPiece } from '@/lib/split-guid';
import { pointInPoly, polyArea, type Pt } from '@/lib/space-sketch-geometry';
import { closeSplit, openSplit } from '@/store/slices/mutation-split';
import type { LayoutFace } from './room-layout';
import type { RoomLink } from './room-occupancy';
import { interiorPoint, roomOutline, type RoomCandidate } from './storey-rooms';
import { rewriteRoomOutline, roomChain, setRoomAreas } from './room-writes';

type Get = () => ViewerState;

export interface LayoutSync {
  created: number[];
  deleted: number[];
  remesh: number[];
}

/** `ring` without its collinear corners (a merge leaves the old wall's ends on the new edge). */
function dropCollinear(ring: readonly Pt[]): Pt[] {
  const out = ring.filter((p, i) => {
    const a = ring[(i + ring.length - 1) % ring.length], b = ring[(i + 1) % ring.length];
    const cross = (p[0] - a[0]) * (b[1] - a[1]) - (p[1] - a[1]) * (b[0] - a[0]);
    return Math.abs(cross) > 1e-9 * Math.max(1, Math.hypot(b[0] - a[0], b[1] - a[1]));
  });
  return out.length >= 3 ? out : [...ring];
}

/** The outline room `link` is written with on `face`. */
const outlineOf = (face: LayoutFace, link: RoomLink) => dropCollinear(roomOutline(face, link.boundary));

const ringKey = (ring: readonly Pt[]) => ring.map((p) => `${p[0].toFixed(4)},${p[1].toFixed(4)}`).join(';');
const areasOf = (face: LayoutFace) => ({ grossArea: polyArea(face.centre), netArea: polyArea(face.inner) });

function chainOf(get: Get, modelId: string, expressId: number) {
  const target = roomChain(get, modelId, expressId);
  if (!target.ok) throw new Error(translate(target.reason === 'storey' ? 'roomLayout.refused.storey' : 'roomLayout.refused.shape'));
  return target.chain;
}

/** Split room `link` into the layout faces `a` and `b`; the larger keeps the room. Returns the new room. */
function splitRoom(get: Get, modelId: string, link: RoomLink, a: LayoutFace, b: LayoutFace): { kept: number; added: number } {
  const chain = chainOf(get, modelId, link.expressId);
  const [first, second] = [outlineOf(a, link), outlineOf(b, link)];
  const keepFirst = keepsFirstPiece(polyArea(first), polyArea(second));
  const [keptFace, cutFace] = keepFirst ? [a, b] : [b, a];
  const open = openSplit(get, (id) => get().storeEditors.get(id) ?? null, modelId, link.expressId, 'slab');
  if (!open.ok) throw new Error(open.reason);
  const { env } = open;
  const added = get().addSpace(modelId, env.storeyExpressId, {
    Profile: 'polygon',
    Position: [0, 0, chain.baseElevation],
    OuterCurve: outlineOf(cutFace, link).map(([x, y]) => [x, y]),
    Height: chain.thickness,
    ...(env.name !== undefined ? { Name: env.name } : {}),
    GlobalId: env.newGlobalId,
  });
  if ('error' in added) throw new Error(added.error);
  rewriteRoomOutline(get, modelId, link.expressId, chain, outlineOf(keptFace, link), areasOf(keptFace));
  closeSplit(get, modelId, env, link.expressId, added.expressId);
  // After the metadata clone, which copied the source's (now stale) quantities.
  setRoomAreas(get, modelId, added.expressId, areasOf(cutFace), chain.thickness);
  return { kept: link.expressId, added: added.expressId };
}

/** The smallest face of `faces` whose axis outline holds `p`. */
function faceHolding<F extends LayoutFace>(faces: readonly F[], p: Pt): F | null {
  let hit: F | null = null;
  for (const f of faces) if (pointInPoly(p[0], p[1], f.centre) && (!hit || polyArea(f.centre) < polyArea(hit.centre))) hit = f;
  return hit;
}

/** Write a layout edit (`before` → `after`) to the rooms it touched. */
export function syncLayoutEdit(get: Get, modelId: string, before: readonly RoomCandidate[], after: readonly LayoutFace[]): LayoutSync {
  const out: LayoutSync = { created: [], deleted: [], remesh: [] };
  const pre = new Map(before.map((c) => [c.face, c]));
  const post = new Map(after.map((f) => [f.face, f]));
  const removed = before.filter((c) => !post.has(c.face));
  const handled = new Set<number>();

  // Splits: a new face cut out of a room's face.
  for (const face of after) {
    if (pre.has(face.face)) continue;
    const parent = faceHolding(before, interiorPoint(face.inner.length >= 3 ? face.inner : face.centre));
    const kept = parent ? post.get(parent.face) : undefined;
    if (!parent?.room || !kept || handled.has(kept.face)) continue;
    const { kept: keptId, added } = splitRoom(get, modelId, parent.room, kept, face);
    handled.add(kept.face).add(face.face);
    out.created.push(added);
    out.remesh.push(keptId, added);
  }

  // Reshapes and merges: a face whose outline changed, or that absorbed faces that are gone.
  for (const face of after) {
    if (handled.has(face.face)) continue;
    const own = pre.get(face.face);
    const absorbed = removed.filter((r) => pointInPoly(r.interior[0], r.interior[1], face.centre));
    const sources = [...(own ? [own] : []), ...absorbed];
    const links = [...new Map(sources.flatMap((c) => (c.room ? [[c.room.expressId, c.room] as const] : []))).values()];
    if (links.length === 0) continue;
    if (absorbed.length === 0 && own && ringKey(own.centre) === ringKey(face.centre)) continue;
    const chains = links.map((link) => ({ link, chain: chainOf(get, modelId, link.expressId) }));
    // The larger room keeps its identity, as a split's larger piece does.
    chains.sort((x, y) => polyArea(y.chain.footprint) - polyArea(x.chain.footprint));
    const [{ link, chain }, ...merged] = chains;
    rewriteRoomOutline(get, modelId, link.expressId, chain, outlineOf(face, link), areasOf(face));
    out.remesh.push(link.expressId);
    for (const m of merged) {
      if (!get().removeEntity(modelId, m.link.expressId)) throw new Error(translate('roomLayout.refused.merge'));
      out.deleted.push(m.link.expressId);
    }
  }
  return out;
}
