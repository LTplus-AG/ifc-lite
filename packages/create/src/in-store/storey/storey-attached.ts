/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The element kinds whose top follows a storey or slab (#9296), with how
 * each one's top is read and moved:
 *
 * - a wall takes a new height (`setWallSectionInStore`: openings checked,
 *   joins kept);
 * - a column takes a new extrusion depth, a grid-bound one included;
 * - a beam or member moves its top end: a vertical one is lengthened, a
 *   level one is lifted whole (a beam under the storey above stays under
 *   it), a sloped one (a brace from one level to the next) keeps its foot
 *   and is turned to reach the new top;
 * - a curtain wall is laid out again at the new height
 *   (`curtain-wall-relayout.ts`).
 *
 * `top` is the measure each kind changes: the height above its base for a
 * wall, column or curtain wall; the top end's height in its placement's
 * parent frame for a beam or member. A move of the top by `d` metres is
 * `top + d` for every kind.
 */

import { editOwnershipRefusal, expandAffectedSet } from '@ifc-lite/export';
import { relayoutCurtainWallHeight, readCurtainWallParts } from '../curtain-wall-relayout.js';
import { resolveLinearElementChain } from '../edit/linear-element-edit.js';
import { getModelLengthUnitScale } from '../edit/length-unit-scale.js';
import type { EditTarget } from '../edit/target.js';
import { setElementSizeInStore } from '../element-size-edit.js';
import { axis3d, placementInAncestor, pointOf, refId, type Vec3 } from '../host-geometry-frame.js';
import { AnchorEntityReader } from '../resolve-anchor.js';
import { setWallSectionInStore } from '../wall-section-edit.js';
import { readWallMetres } from '../wall-size-edit.js';
import { readPlacementLeaf, worldLiftInParent, writeShiftedPlacement } from './storey-placement.js';
import { placementWorldZ } from './storey-grid.js';

export type AttachedKind = 'wall' | 'column' | 'linear' | 'curtainWall';

const KINDS: Record<string, AttachedKind> = {
  IFCWALL: 'wall', IFCWALLSTANDARDCASE: 'wall', IFCWALLELEMENTEDCASE: 'wall',
  IFCCOLUMN: 'column', IFCCOLUMNSTANDARDCASE: 'column',
  IFCBEAM: 'linear', IFCBEAMSTANDARDCASE: 'linear', IFCMEMBER: 'linear', IFCMEMBERSTANDARDCASE: 'linear',
  IFCCURTAINWALL: 'curtainWall',
};

/** Below this an element would be a sliver, metres: an edit that leaves one is refused. */
export const MIN_ATTACHED_EXTENT = 0.01;

export function attachedKind(type: string | undefined): AttachedKind | null {
  return type ? KINDS[type.toUpperCase()] ?? null : null;
}

export type AttachedOutcome = { readonly ok: true; readonly remesh: number[] } | { readonly ok: false; readonly reason: string };

function number(value: unknown): number | null {
  const raw = typeof value === 'object' && value !== null && 'real' in value ? (value as { real: unknown }).real : value;
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
}

/** A column's single vertical body: one extrusion straight up from its placement, which stands upright. */
function columnBody(target: EditTarget, columnId: number): { solidId: number; depth: number; base: number } | null {
  const reader = new AnchorEntityReader(target.dataStore, target.view);
  const column = reader.entity(columnId);
  const placement = column ? reader.entity(refId(column.attributes[5]) ?? -1) : null;
  const frame = placement?.type.toUpperCase() === 'IFCLOCALPLACEMENT' ? axis3d(reader, placement.attributes[1]) : null;
  if (!column || !frame || Math.abs(frame.z[2] - 1) > 1e-9) return null;
  const shape = reader.entity(refId(column.attributes[6]) ?? -1);
  const reps = Array.isArray(shape?.attributes[2]) ? shape!.attributes[2] as unknown[] : [];
  const body = reps.map((value) => reader.entity(refId(value) ?? -1)).filter((rep) => rep?.attributes[1] === 'Body');
  const items = body.length === 1 ? body[0]!.attributes[3] : null;
  const solidId = Array.isArray(items) && items.length === 1 ? refId(items[0]) : null;
  const solid = solidId === null ? null : reader.entity(solidId);
  if (solid?.type.toUpperCase() !== 'IFCEXTRUDEDAREASOLID') return null;
  const position = axis3d(reader, solid.attributes[1]);
  const direction = pointOf(reader, solid.attributes[2], 'IFCDIRECTION');
  const depth = number(solid.attributes[3]);
  if (!position || !direction || depth === null || depth <= 0 || Math.abs(position.z[2] - 1) > 1e-9
    || Math.abs(direction[0]) > 1e-9 || Math.abs(direction[1]) > 1e-9 || direction[2] <= 0) return null;
  // Straight up, so the depth is the height; the solid may start above its placement (an imported column).
  const scale = getModelLengthUnitScale(target.dataStore);
  return { solidId: solidId!, depth: depth * scale, base: position.o[2] * scale };
}

/** A beam's or member's ends in its placement's parent frame, metres. */
function linearEnds(target: EditTarget, id: number) {
  const scale = getModelLengthUnitScale(target.dataStore);
  const chain = resolveLinearElementChain(target.dataStore, target.view, target.editor, id, scale);
  if (!chain) return null;
  const start = chain.startCoordinates;
  const a = chain.axisDirection;
  const end: Vec3 = [start[0] + a[0] * chain.depth, start[1] + a[1] * chain.depth, start[2] + a[2] * chain.depth];
  return { chain, start, end, scale };
}

/** The element's `top` (see the module comment), metres; null when its body cannot be read. */
export function readAttachedTop(target: EditTarget, id: number, kind: AttachedKind): number | null {
  if (kind === 'wall') {
    const wall = readWallMetres(target, id);
    return wall && Number.isFinite(wall.height) ? wall.height : null;
  }
  if (kind === 'column') return columnBody(target, id)?.depth ?? null;
  if (kind === 'curtainWall') return readCurtainWallParts(target, id)?.height ?? null;
  const ends = linearEnds(target, id);
  return ends ? Math.max(ends.start[2], ends.end[2]) : null;
}

/** World Z of the element's base (walls, curtain walls: their placement; columns: where the solid starts) or its placement's parent origin (beams), metres. */
export function attachedTopWorldOrigin(target: EditTarget, id: number, kind: AttachedKind): number | null {
  const reader = new AnchorEntityReader(target.dataStore, target.view);
  const placementId = refId(reader.entity(id)?.attributes[5]);
  const scale = getModelLengthUnitScale(target.dataStore);
  if (placementId === null) return null;
  // A grid-bound column hangs from an IfcGridPlacement: read through it.
  const z = kind !== 'linear' ? placementWorldZ(reader, placementId) : null;
  // A column's body may start above its placement: its base is where the solid starts.
  if (kind === 'column') { const body = columnBody(target, id); return z === null || !body ? null : z * scale + body.base; }
  if (kind !== 'linear') return z === null ? null : z * scale;
  const parentId = refId(reader.entity(placementId)?.attributes[0]);
  if (parentId === null) return 0;
  return (placementInAncestor(reader, parentId, null)?.o[2] ?? Number.NaN) * scale;
}

/**
 * Whether moving the element's top rewrites its body (a wall's, column's or
 * curtain wall's extrusion, a vertical or sloped member's depth) rather than
 * only its own placement (a level beam or member is lifted whole). A body
 * shared with another element cannot be rewritten for one of them.
 */
export function attachedTopEditsBody(target: EditTarget, id: number, kind: AttachedKind): boolean {
  if (kind !== 'linear') return true;
  const ends = linearEnds(target, id);
  return !ends || Math.abs(ends.chain.axisDirection[2]) >= 1e-9;
}

/** Move the element's top from `from` to `to` (metres, its `top` measure). Caller owns the atomic transaction. */
export function writeAttachedTop(target: EditTarget, id: number, kind: AttachedKind, from: number, to: number): AttachedOutcome {
  if (kind === 'wall') return setWallSectionInStore(target, id, { height: to });
  if (kind === 'curtainWall') return relayoutCurtainWallHeight(target, id, to);
  if (kind === 'column') return setColumnHeight(target, id, to);
  return liftLinearTop(target, id, to - from);
}

function setColumnHeight(target: EditTarget, id: number, height: number): AttachedOutcome {
  if (!(height >= MIN_ATTACHED_EXTENT)) return { ok: false, reason: 'A column needs a height greater than zero' };
  const body = columnBody(target, id);
  if (!body) return { ok: false, reason: 'This column is not a single vertical extrusion, so its height cannot follow' };
  if (Math.abs(body.depth - height) < 1e-9) return { ok: true, remesh: [] };
  const ownership = editOwnershipRefusal(target.dataStore, target.view, [body.solidId], expandAffectedSet(target.dataStore, target.view, [id], 'hostsChanged'));
  if (ownership) return { ok: false, reason: ownership };
  target.editor.setPositionalAttribute(body.solidId, 3, Math.round(height / getModelLengthUnitScale(target.dataStore) * 1e9) / 1e9);
  return { ok: true, remesh: [id] };
}

/** Raise a beam's or member's top end by `change` metres; see the module comment. */
function liftLinearTop(target: EditTarget, id: number, change: number): AttachedOutcome {
  const ends = linearEnds(target, id);
  if (!ends) return { ok: false, reason: 'This element is not a straight extrusion, so its top cannot follow' };
  const { chain, start, end, scale } = ends;
  const a = chain.axisDirection;
  if (Math.abs(change) < 1e-12) return { ok: true, remesh: [] };
  if (Math.abs(a[2]) > 1 - 1e-9) {
    // Vertical: the upper end moves, the lower stays.
    const length = chain.depth + change;
    if (!(length >= MIN_ATTACHED_EXTENT)) return { ok: false, reason: `It would end ${length.toFixed(3)} m long` };
    return setElementSizeInStore(target, id, { kind: 'linear', length, fixed: a[2] > 0 ? 'start' : 'end' });
  }
  const reader = new AnchorEntityReader(target.dataStore, target.view);
  const placementId = refId(reader.entity(id)?.attributes[5]);
  const leaf = placementId === null ? null : readPlacementLeaf(reader, placementId);
  if (!leaf) return { ok: false, reason: 'Its placement cannot be read' };
  const level = Math.abs(a[2]) < 1e-9;
  // A level lift writes only the placement; a turn writes the solid's depth too.
  const ownership = editOwnershipRefusal(target.dataStore, target.view, level ? [leaf.placementId] : [leaf.placementId, chain.extrudedSolidId],
    expandAffectedSet(target.dataStore, target.view, [id], 'hostsChanged'));
  if (ownership) return { ok: false, reason: ownership };
  if (level) {
    // Level: the whole element follows, so it stays at the same depth under the storey.
    const lift = worldLiftInParent(reader, leaf.parentId, change / scale);
    if (!lift) return { ok: false, reason: 'Its placement cannot be read' };
    writeShiftedPlacement(target.editor, leaf, lift);
    return { ok: true, remesh: [id] };
  }
  // Sloped: the foot stays, the top end rises; the profile's X (horizontal, across the run) is unchanged.
  const startIsTop = start[2] > end[2];
  const top: Vec3 = startIsTop ? [start[0], start[1], start[2] + change] : [end[0], end[1], end[2] + change];
  const from = startIsTop ? top : start, to = startIsTop ? end : top;
  const delta: Vec3 = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
  const length = Math.hypot(...delta);
  if (!(length >= MIN_ATTACHED_EXTENT) || Math.sign(delta[2]) !== Math.sign(end[2] - start[2])) {
    return { ok: false, reason: 'Its top would pass its foot' };
  }
  const axis = delta.map((v) => v / length) as Vec3;
  const ref = leaf.refDirection === null ? null : pointOf(reader, leaf.refDirection, 'IFCDIRECTION');
  if (ref && Math.abs(ref[0] * axis[0] + ref[1] * axis[1] + ref[2] * axis[2]) > 1e-6 * Math.hypot(...ref)) {
    return { ok: false, reason: 'Its section is not set square to the slope, so it cannot be turned' };
  }
  const native = (metres: number) => Math.round(metres / scale * 1e9) / 1e9;
  target.editor.setPositionalAttribute(chain.extrudedSolidId, 3, native(length));
  const point = target.editor.addEntity('IfcCartesianPoint', [from.map(native)]).expressId;
  const direction = target.editor.addEntity('IfcDirection', [axis]).expressId;
  const refRef = refId(leaf.refDirection);
  const placement = target.editor.addEntity('IfcAxis2Placement3D', [`#${point}`, `#${direction}`, refRef === null ? null : `#${refRef}`]).expressId;
  target.editor.setPositionalAttribute(leaf.placementId, 1, `#${placement}`);
  return { ok: true, remesh: [id] };
}
