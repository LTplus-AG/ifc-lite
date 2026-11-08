/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A curtain wall given a new height, laid out again rather than stretched
 * (#9296): what `curtainWallLayout` builds for the new height is written onto
 * the existing parts, so every mullion, transom and panel keeps its identity.
 *
 * The layout is read back from the parts `addCurtainWallToStore` writes
 * (`curtain-wall.ts`): mullions stand at their U offset and run full height,
 * transoms lie at their V height along the path, panels fill the openings.
 * The U grid is unchanged. The file records no V-grid spec, so the V grid is
 * read from where the transoms are: interior lines at exact equal fractions
 * of the height are re-spaced proportionally to the new height, and any
 * other line keeps its height above the base. That includes lines GIVEN at
 * heights that happen to divide the wall equally (`VGrid: [1, 2]` on a 3 m
 * wall): they are re-spaced proportionally too (to 1.33 m and 2.67 m at
 * 4 m), not kept. Recording the spec needs a property set whose GlobalId
 * stays the same across exports; tracked in #9352.
 * Mullions get the new height, transoms and panels move to their new rows and
 * panels take the new clear heights. A layout whose rows no longer fit is
 * refused, as the builder refuses it.
 */

import { editOwnershipRefusal, expandAffectedSet } from '@ifc-lite/export';
import { readPlacementLeaf, writeShiftedPlacement } from './storey/storey-placement.js';
import { AnchorEntityReader } from './resolve-anchor.js';
import { axis3d, pointOf, refId } from './host-geometry-frame.js';
import { getModelLengthUnitScale } from './edit/length-unit-scale.js';
import type { EditTarget } from './edit/target.js';

const EPS = 1e-6;
const snap = (x: number) => Math.round(x * 1e9) / 1e9;

interface Part {
  readonly id: number;
  readonly role: 'mullion' | 'transom' | 'panel';
  readonly placementId: number;
  readonly solidId: number;
  /** Location in the curtain wall's frame, metres: u along the path, v up. */
  readonly u: number;
  readonly v: number;
  /** Extrusion depth, metres. */
  readonly depth: number;
}

export interface CurtainWallParts {
  readonly curtainWallId: number;
  /** Metres. */
  readonly height: number;
  readonly parts: readonly Part[];
}

export type CurtainWallRelayoutOutcome =
  | { readonly ok: true; readonly remesh: number[] }
  | { readonly ok: false; readonly reason: string };

function number(value: unknown): number | null {
  const raw = typeof value === 'object' && value !== null && 'real' in value ? (value as { real: unknown }).real : value;
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
}

/** The parts of a curtain wall as the builder lays them out, or null for any other structure. */
export function readCurtainWallParts(target: EditTarget, curtainWallId: number): CurtainWallParts | null {
  const reader = new AnchorEntityReader(target.dataStore, target.view);
  const wall = reader.entity(curtainWallId);
  if (wall?.type.toUpperCase() !== 'IFCCURTAINWALL') return null;
  const wallPlacement = refId(wall.attributes[5]);
  const scale = getModelLengthUnitScale(target.dataStore);
  if (wallPlacement === null || !(scale > 0)) return null;
  const members: number[] = [];
  for (const relId of reader.ids('IFCRELAGGREGATES')) {
    const rel = reader.entity(relId);
    if (!rel || refId(rel.attributes[4]) !== curtainWallId) continue;
    const related = rel.attributes[5];
    if (Array.isArray(related)) for (const value of related) { const id = refId(value); if (id !== null) members.push(id); }
  }
  if (members.length === 0) return null;
  const parts: Part[] = [];
  for (const id of members) {
    const part = reader.entity(id);
    const type = part?.type.toUpperCase();
    if (!part || (type !== 'IFCMEMBER' && type !== 'IFCPLATE')) return null;
    const placementId = refId(part.attributes[5]);
    const placement = placementId === null ? null : reader.entity(placementId);
    if (placement?.type.toUpperCase() !== 'IFCLOCALPLACEMENT' || refId(placement.attributes[0]) !== wallPlacement) return null;
    const frame = axis3d(reader, placement.attributes[1]);
    // One body: a vertical-or-along-path extrusion with no frame of its own.
    const shape = reader.entity(refId(part.attributes[6]) ?? -1);
    const reps = shape?.attributes[2];
    const rep = Array.isArray(reps) && reps.length === 1 ? reader.entity(refId(reps[0]) ?? -1) : null;
    const items = rep?.attributes[3];
    const solidId = Array.isArray(items) && items.length === 1 ? refId(items[0]) : null;
    const solid = solidId === null ? null : reader.entity(solidId);
    const depth = solid?.type.toUpperCase() === 'IFCEXTRUDEDAREASOLID' ? number(solid.attributes[3]) : null;
    const solidFrame = solid ? axis3d(reader, solid.attributes[1]) : null;
    const direction = solid ? pointOf(reader, solid.attributes[2], 'IFCDIRECTION') : null;
    if (!frame || depth === null || depth <= 0 || !solidFrame || !direction || solidId === null
      || solidFrame.o.some((v) => Math.abs(v) > 1e-9) || Math.abs(solidFrame.z[2] - 1) > 1e-9
      || Math.abs(direction[0]) > 1e-9 || Math.abs(direction[1]) > 1e-9 || direction[2] <= 0
      || Math.abs(frame.o[1]) > 1e-9) return null;
    const vertical = Math.abs(frame.z[2] - 1) < 1e-9;
    const alongPath = Math.abs(frame.z[0] - 1) < 1e-9 && Math.abs(frame.x[2] + 1) < 1e-9;
    const role = type === 'IFCPLATE' ? (vertical ? 'panel' : null) : vertical ? 'mullion' : alongPath ? 'transom' : null;
    if (!role) return null;
    parts.push({ id, role, placementId: placementId!, solidId, u: frame.o[0] * scale, v: frame.o[2] * scale, depth: depth * scale });
  }
  const mullions = parts.filter((part) => part.role === 'mullion');
  const panels = parts.filter((part) => part.role === 'panel');
  if (panels.length === 0) return null;
  // Mullions run full height; without them the top row of panels reaches it.
  const height = mullions.length ? mullions[0].depth : Math.max(...panels.map((panel) => panel.v + panel.depth));
  if (mullions.some((mullion) => Math.abs(mullion.depth - height) > EPS || Math.abs(mullion.v) > EPS)) return null;
  return { curtainWallId, height, parts };
}

const distinct = (values: readonly number[]): number[] => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.filter((value, i) => i === 0 || value - sorted[i - 1] > EPS);
};
const rowOf = (rows: readonly number[], value: number): number => rows.findIndex((row) => Math.abs(row - value) <= EPS);

/** The new V layout for `height`, or the reason the rows no longer fit. */
function relaidRows(wall: CurtainWallParts, height: number): { transoms: number[]; panels: Array<[number, number]>; rows: number[]; panelRows: number[] } | string {
  const transoms = wall.parts.filter((part) => part.role === 'transom');
  const panels = wall.parts.filter((part) => part.role === 'panel');
  const rows = distinct(transoms.map((part) => part.v));
  const panelRows = distinct(panels.map((part) => part.v));
  // With edge members the bottom panels start above the bottom transom.
  const edge = panelRows[0] > EPS;
  if (edge && rows.length < 2) return 'its frame cannot be read';
  const interior = edge ? rows.slice(1, -1) : rows;
  if (panelRows.length !== interior.length + 1) return 'its rows cannot be read';
  // The transom's extent across its row: the bottom edge transom is centred
  // on h / 2; without edges the bottom panels stop h / 2 below the first line.
  const bottom = panels.find((panel) => Math.abs(panel.v - panelRows[0]) <= EPS)!;
  const h = edge ? 2 * rows[0] : interior.length ? 2 * (interior[0] - bottom.depth) : 0;
  const n = interior.length + 1;
  const proportional = interior.every((line, k) => Math.abs(line - wall.height * (k + 1) / n) <= EPS);
  const lines = interior.map((line, k) => (proportional ? height * (k + 1) / n : line));
  const newRows = edge ? [h / 2, ...lines, height - h / 2] : lines;
  const all = [0, ...lines, height];
  const bays: Array<[number, number]> = [];
  for (let k = 0; k < n; k++) {
    const v0 = k === 0 ? (edge ? h : 0) : all[k] + h / 2;
    const v1 = k === n - 1 ? (edge ? height - h : height) : all[k + 1] - h / 2;
    if (v1 - v0 <= 1e-9) return `the transoms would leave no clear opening in row ${k + 1}`;
    bays.push([snap(v0), snap(v1)]);
  }
  if (lines.some((line, k) => line >= height - 1e-9 || (k > 0 && line <= lines[k - 1]))) return 'a transom would sit above the new top';
  return { transoms: newRows.map(snap), panels: bays, rows, panelRows };
}

/**
 * Lay a curtain wall out again at `height` metres. Caller owns the atomic
 * transaction; a refusal writes nothing.
 */
export function relayoutCurtainWallHeight(target: EditTarget, curtainWallId: number, height: number): CurtainWallRelayoutOutcome {
  if (!(Number.isFinite(height) && height > 0)) return { ok: false, reason: 'A curtain wall height must be greater than zero' };
  const wall = readCurtainWallParts(target, curtainWallId);
  if (!wall) return { ok: false, reason: 'This curtain wall is not a mullion, transom and panel layout this editor can rebuild' };
  if (Math.abs(wall.height - height) < 1e-9) return { ok: true, remesh: [] };
  const layout = relaidRows(wall, height);
  if (typeof layout === 'string') return { ok: false, reason: `This curtain wall cannot be laid out ${height.toFixed(3)} m tall: ${layout}` };
  const scale = getModelLengthUnitScale(target.dataStore);
  const native = (metres: number) => snap(metres / scale);
  const depths: Array<{ id: number; value: number }> = [];
  const lifts: Array<{ placementId: number; dv: number }> = [];
  for (const part of wall.parts) {
    if (part.role === 'mullion') depths.push({ id: part.solidId, value: native(height) });
    else if (part.role === 'transom') {
      const v = layout.transoms[rowOf(layout.rows, part.v)];
      if (Math.abs(v - part.v) > 1e-12) lifts.push({ placementId: part.placementId, dv: v - part.v });
    } else {
      const [v0, v1] = layout.panels[rowOf(layout.panelRows, part.v)];
      if (Math.abs(v0 - part.v) > 1e-12) lifts.push({ placementId: part.placementId, dv: v0 - part.v });
      if (Math.abs(v1 - v0 - part.depth) > 1e-12) depths.push({ id: part.solidId, value: native(v1 - v0) });
    }
  }
  const products = [curtainWallId, ...wall.parts.map((part) => part.id)];
  const ownership = editOwnershipRefusal(target.dataStore, target.view, [...depths.map((d) => d.id), ...lifts.map((l) => l.placementId)],
    expandAffectedSet(target.dataStore, target.view, products, 'hostsChanged'));
  if (ownership) return { ok: false, reason: ownership };
  const reader = new AnchorEntityReader(target.dataStore, target.view);
  const leaves = lifts.map((lift) => ({ lift, leaf: readPlacementLeaf(reader, lift.placementId) }));
  if (leaves.some(({ leaf }) => !leaf)) return { ok: false, reason: 'A part of this curtain wall has a placement that cannot be read' };
  for (const { id, value } of depths) target.editor.setPositionalAttribute(id, 3, value);
  // Parts are placed in the curtain wall's frame, whose Z is the wall's up.
  for (const { lift, leaf } of leaves) writeShiftedPlacement(target.editor, leaf!, [0, 0, lift.dv / scale]);
  return { ok: true, remesh: products };
}
