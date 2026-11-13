/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { PropertyValueType } from '@ifc-lite/data';
import { effectiveReferencers } from '@ifc-lite/export';
import type { EditTarget } from './edit/target.js';
import { getModelLengthUnitScale } from './edit/length-unit-scale.js';
import { wallBaseSolid, ROOF_ATTACHMENT } from './edit/wall-base-solid.js';
import { AnchorEntityReader } from './resolve-anchor.js';
import { axis2d, axis3d, applyFrame, composeFrame, inverseFrame, placementInAncestor, pointOf, refId, type Vec3 } from './host-geometry-frame.js';
import { readFootprintRoofInStore, planFootprintRoofNative, emitFootprintRoofBody } from './roof-footprint.js';
import { heightAt, type PlanPoint } from './roof-footprint-plan.js';

function frame(target: EditTarget, id: number) {
  const reader = new AnchorEntityReader(target.dataStore, target.view);
  const placement = refId(reader.entity(id)?.attributes[5]);
  const result = placement === null ? null : placementInAncestor(reader, placement, null);
  if (!result || Math.abs(result.z[2] - 1) > 1e-9) throw new Error(`#${id} needs an upright placement to attach a wall top`);
  return result;
}
/** Highest underside point; the actual wall top is cut to each roof plane below this envelope. */
export function roofUndersideWorld(target: EditTarget, roofId: number): number | null {
  const definition = readFootprintRoofInStore(target.dataStore, roofId, target.view);
  if (!definition) return null;
  const scale = getModelLengthUnitScale(target.dataStore);
  const plan = planFootprintRoofNative({ lengthUnitScale: scale }, definition);
  return (frame(target, roofId).o[2] + plan.rise) * scale;
}
function contains(outline: readonly PlanPoint[], p: readonly number[]): boolean {
  let inside = false;
  for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
    const a = outline[j], b = outline[i], dx = b[0] - a[0], dy = b[1] - a[1];
    const cross = (p[0] - a[0]) * dy - (p[1] - a[1]) * dx;
    if (Math.abs(cross) < 1e-8 * Math.max(1, Math.hypot(dx, dy)) && (p[0] - a[0]) * (p[0] - b[0]) + (p[1] - a[1]) * (p[1] - b[1]) <= 1e-8) return true;
    if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < a[0] + (p[1] - a[1]) * dx / dy) inside = !inside;
  }
  return inside;
}
function covered(boundary: readonly Vec3[], eaves: readonly PlanPoint[]): boolean {
  for (let i = 0; i < boundary.length; i++) {
    const a = boundary[i], b = boundary[(i + 1) % boundary.length], dx = b[0] - a[0], dy = b[1] - a[1];
    if (!contains(eaves, a)) return false;
    const ts = [0, 1];
    for (let j = 0; j < eaves.length; j++) {
      const p = eaves[j], q = eaves[(j + 1) % eaves.length], ex = q[0] - p[0], ey = q[1] - p[1];
      const det = dx * ey - dy * ex;
      if (Math.abs(det) < 1e-12) continue;
      const t = ((p[0] - a[0]) * ey - (p[1] - a[1]) * ex) / det;
      const u = ((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / det;
      if (t > 0 && t < 1 && u >= 0 && u <= 1) ts.push(t);
    }
    ts.sort((x, y) => x - y);
    for (let j = 1; j < ts.length; j++) {
      const t = (ts[j - 1] + ts[j]) / 2;
      if (!contains(eaves, [a[0] + t * dx, a[1] + t * dy])) return false;
    }
  }
  return true;
}
function body(target: EditTarget, wallId: number) {
  const reader = new AnchorEntityReader(target.dataStore, target.view);
  const shape = reader.entity(refId(reader.entity(wallId)?.attributes[6]) ?? -1);
  const reps = Array.isArray(shape?.attributes[2]) ? shape.attributes[2] : [];
  const repId = reps.map(refId).find((id): id is number => id !== null && reader.entity(id)?.attributes[1] === 'Body');
  const rep = repId === undefined ? null : reader.entity(repId);
  const items = rep?.attributes[3];
  const root = Array.isArray(items) && items.length === 1 ? refId(items[0]) : null;
  const base = wallBaseSolid(reader, target.view, wallId, root);
  const solid = base === null ? null : reader.entity(base);
  if (repId === undefined || root === null || base === null || solid?.type.toUpperCase() !== 'IFCEXTRUDEDAREASOLID') throw new Error(`Wall #${wallId} needs a single extruded body to attach to a roof`);
  return { reader, repId, root, base, solid };
}
function boundary(target: EditTarget, solid: { attributes: readonly unknown[] }): Vec3[] {
  const reader = new AnchorEntityReader(target.dataStore, target.view);
  const profile = reader.entity(refId(solid.attributes[0]) ?? -1);
  let points: PlanPoint[];
  if (profile?.type.toUpperCase() === 'IFCRECTANGLEPROFILEDEF') {
    const w = profile.attributes[3], d = profile.attributes[4], f = axis2d(reader, profile.attributes[2]);
    if (typeof w !== 'number' || typeof d !== 'number' || !f) throw new Error('Unreadable wall profile');
    points = ([[-1, -1], [1, -1], [1, 1], [-1, 1]] as const).map(([x, y]) => [f.o[0] + x * w / 2 * f.x[0] - y * d / 2 * f.x[1], f.o[1] + x * w / 2 * f.x[1] + y * d / 2 * f.x[0]]);
  } else if (profile?.type.toUpperCase() === 'IFCARBITRARYCLOSEDPROFILEDEF') {
    const line = reader.entity(refId(profile.attributes[2]) ?? -1);
    const refs = line?.attributes[0];
    if (!Array.isArray(refs)) throw new Error('Unreadable wall profile');
    points = refs.map(ref => { const p = pointOf(reader, ref, 'IFCCARTESIANPOINT', 2); if (!p) throw new Error('Unreadable wall profile point'); return [p[0], p[1]]; });
  } else throw new Error('This wall profile cannot attach to a roof');
  const f = axis3d(reader, solid.attributes[1]);
  if (!f) throw new Error('Unreadable wall solid placement');
  return points.map(p => applyFrame(f, [p[0], p[1], 0]));
}
/** Delete only unreferenced geometry from our replaced Boolean chain; keep its editable base. */
function removeCuts(target: EditTarget, root: number, base: number): void {
  const reader = new AnchorEntityReader(target.dataStore, target.view), found = new Set<number>(), stack = [root];
  const refs = (v: unknown): void => { if (Array.isArray(v)) v.forEach(refs); else { const id = refId(v); if (id !== null) stack.push(id); } };
  while (stack.length) { const id = stack.pop()!; if (id === base || found.has(id)) continue; const e = reader.entity(id); if (!e) continue; found.add(id); e.attributes.forEach(refs); }
  const incoming = effectiveReferencers(target.dataStore, target.view);
  for (let changed = true; changed;) { changed = false; for (const id of found) if (incoming(id).some(parent => !found.has(parent))) { found.delete(id); changed = true; } }
  for (const id of found) target.editor.removeEntity(id);
}
/** Caller owns an atomic edit. The cutters start exactly on the shared roof underside. */
export function clipWallToRoof(target: EditTarget, wallId: number, roofId: number): void {
  const definition = readFootprintRoofInStore(target.dataStore, roofId, target.view);
  // A roof without a footprint has a planar underside: drop any earlier roof's cut.
  if (!definition) { clearWallRoofClip(target, wallId); return; }
  const scale = getModelLengthUnitScale(target.dataStore), unit = { lengthUnitScale: scale };
  const roofFrame = frame(target, roofId), wallFrame = frame(target, wallId);
  const roofToWall = composeFrame(inverseFrame(wallFrame), roofFrame);
  const wallToRoof = composeFrame(inverseFrame(roofFrame), wallFrame);
  const plan = planFootprintRoofNative(unit, definition), own = body(target, wallId);
  const corners = boundary(target, own.solid).map(p => applyFrame(wallToRoof, p));
  if (!covered(corners, plan.eaves)) throw new Error(`The roof #${roofId} does not cover the whole wall #${wallId}`);
  for (const p of corners) {
    const face = plan.planes.find(face => contains(face.outline, p));
    const height = face ? heightAt(face, [p[0], p[1]]) : 0;
    if (height - p[2] < .01 / scale) throw new Error(`The roof #${roofId} is below the wall's base`);
  }
  const signature = JSON.stringify([roofFrame, wallFrame, definition, corners, own.solid.attributes[3]]);
  if (target.view.getPropertyValue(wallId, ROOF_ATTACHMENT, 'Clipped') === true && target.view.getPropertyValue(wallId, ROOF_ATTACHMENT, 'Signature') === signature) return;
  const cap = (Math.abs(roofFrame.o[2] - wallFrame.o[2]) + plan.rise + Number(own.solid.attributes[3]) + 1 / scale) * scale * 2;
  const rep = own.reader.entity(own.repId)!;
  const context = refId(rep.attributes[0]);
  if (context === null) throw new Error('Unreadable wall representation context');
  const cutters = emitFootprintRoofBody(target.editor, unit, context, { ...definition, Thickness: cap });
  let root = own.base;
  for (const id of cutters.solidIds) {
    const solid = own.reader.entity(id)!;
    const local = axis3d(own.reader, solid.attributes[1]);
    if (!local) throw new Error('Unreadable roof cutter placement');
    const f = composeFrame(roofToWall, local);
    const point = target.editor.addEntity('IfcCartesianPoint', [f.o]).expressId;
    const axis = target.editor.addEntity('IfcDirection', [f.z]).expressId;
    const direction = target.editor.addEntity('IfcDirection', [f.x]).expressId;
    const position = target.editor.addEntity('IfcAxis2Placement3D', [`#${point}`, `#${axis}`, `#${direction}`]).expressId;
    const oldPosition = refId(solid.attributes[1]);
    target.editor.setPositionalAttribute(id, 1, `#${position}`);
    // The freshly generated placement is exclusively ours and was replaced above.
    if (oldPosition !== null) removeCuts(target, oldPosition, -1);
    root = target.editor.addEntity('IfcBooleanResult', ['.DIFFERENCE.', `#${root}`, `#${id}`]).expressId;
  }
  // StandardCase requires an extrusion/clipping representation, not general Boolean CSG.
  if (target.editor.getEntityType(wallId)?.toUpperCase() === 'IFCWALLSTANDARDCASE') target.editor.setEntityType(wallId, 'IfcWall');
  target.editor.setPositionalAttribute(own.repId, 2, 'CSG');
  target.editor.setPositionalAttribute(own.repId, 3, [`#${root}`]);
  target.view.setProperty(wallId, ROOF_ATTACHMENT, 'Clipped', true, PropertyValueType.Boolean);
  target.view.setProperty(wallId, ROOF_ATTACHMENT, 'Signature', signature, PropertyValueType.Text);
  target.editor.removeEntity(cutters.productShapeId); target.editor.removeEntity(cutters.shapeRepId);
  if (own.root !== own.base) removeCuts(target, own.root, own.base);
}

/** Switching to a level or slab restores a planar wall top; detaching alone can keep the last cut shape. */
export function clearWallRoofClip(target: EditTarget, wallId: number): void {
  if (target.view.getPropertyValue(wallId, ROOF_ATTACHMENT, 'Clipped') !== true) return;
  const own = body(target, wallId);
  target.editor.setPositionalAttribute(own.repId, 2, 'SweptSolid');
  target.editor.setPositionalAttribute(own.repId, 3, [`#${own.base}`]);
  target.view.setProperty(wallId, ROOF_ATTACHMENT, 'Clipped', false, PropertyValueType.Boolean);
  if (own.root !== own.base) removeCuts(target, own.root, own.base);
}
