/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { StoreEditor } from '@ifc-lite/mutations';
import { emitPolygonProfile } from './_emit-helpers.js';
import { heightAt, type FootprintRoofPlan } from './roof-footprint-plan.js';
import type { MitredPlane } from './roof-mitre-plan.js';
import { cross3, dot3, type Cut, type Point } from './roof-mitre-polyhedron.js';

/** Remove the negative side: IFC AgreementFlag TRUE points the normal away
 * from the removed half-space. The retained solid satisfies n·p >= k. */
function halfSpace(editor: StoreEditor, cut: Cut): number {
  const point = editor.addEntity('IfcCartesianPoint', [cut.n.map(v => v * cut.k)]).expressId;
  const axis = editor.addEntity('IfcDirection', [cut.n]).expressId;
  const reference = cross3(cut.n, Math.abs(cut.n[0]) < .8 ? [1, 0, 0] : [0, 1, 0]);
  const x = editor.addEntity('IfcDirection', [reference]).expressId;
  const position = editor.addEntity('IfcAxis2Placement3D', [`#${point}`, `#${axis}`, `#${x}`]).expressId;
  const plane = editor.addEntity('IfcPlane', [`#${position}`]).expressId;
  return editor.addEntity('IfcHalfSpaceSolid', [`#${plane}`, true]).expressId;
}

/** Swept solids remain the source geometry, trimmed by standard bisecting
 * half-spaces. A valley can have several disjoint clipping regions, joined
 * under one item so its edge identity and IfcStyledItem remain meaningful. */
export function emitMitredPlanes(editor: StoreEditor, plan: FootprintRoofPlan, thickness: number, mitres: readonly MitredPlane[]) {
  const solidIds: number[] = [], profileIds: number[] = [];
  for (let i = 0; i < plan.planes.length; i++) {
    const face = plan.planes[i], [dx, dy] = face.direction;
    const sin = Math.sin(face.slope), cos = Math.cos(face.slope);
    const x: Point = [dx, dy, 0], y: Point = [-dy * cos, dx * cos, sin], z: Point = [dy * sin, -dx * sin, cos];
    const local = plan.eaves.map((p): [number, number] => {
      const q: Point = [p[0] - face.origin[0], p[1] - face.origin[1], heightAt(face, p)];
      return [dot3(q, x), dot3(q, y)];
    });
    const profile = emitPolygonProfile(editor, local); profileIds.push(profile);
    const origin = editor.addEntity('IfcCartesianPoint', [[...face.origin, 0]]).expressId;
    const axis = editor.addEntity('IfcDirection', [z]).expressId;
    const ref = editor.addEntity('IfcDirection', [x]).expressId;
    const position = editor.addEntity('IfcAxis2Placement3D', [`#${origin}`, `#${axis}`, `#${ref}`]).expressId;
    const up = editor.addEntity('IfcDirection', [[0, sin, cos]]).expressId;
    const base = editor.addEntity('IfcExtrudedAreaSolid', [`#${profile}`, `#${position}`, `#${up}`, thickness / cos]).expressId;
    const regions = mitres[i].regions.map(cuts => {
      let root = base;
      for (const cut of cuts) root = editor.addEntity('IfcBooleanClippingResult', ['.DIFFERENCE.', `#${root}`, `#${halfSpace(editor, cut)}`]).expressId;
      return root;
    });
    let root = regions[0];
    for (const region of regions.slice(1)) root = editor.addEntity('IfcBooleanResult', ['.UNION.', `#${root}`, `#${region}`]).expressId;
    solidIds.push(root);
  }
  return { solidIds, profileIds };
}
