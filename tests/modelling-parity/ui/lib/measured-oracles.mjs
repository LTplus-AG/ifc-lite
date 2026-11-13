/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Export-level oracles for #9296 round 5; every relation is checked against the target. */
export const typeOf = (step, id) => step.of('IFCRELDEFINESBYTYPE').find(r => r.args[4]?.some(v => v.ref === id))?.args[5]?.ref;
export function classificationOf(step, id, expectedCode) {
  return step.of('IFCRELASSOCIATESCLASSIFICATION').some(r => r.args[4]?.some(v => v.ref === id) && step.get(r.args[5])?.type === 'IFCCLASSIFICATIONREFERENCE' && (expectedCode === undefined || step.get(r.args[5])?.args[1] === expectedCode));
}
export function inheritedFireRating(step, walls) {
  const types = new Set(walls.map(w => typeOf(step, w.id)));
  const sets = step.of('IFCPROPERTYSET').filter(ps => ps.args[2] === 'Pset_WallCommon' && ps.args[4]?.some(r => {
    const p = step.get(r); return p?.args[0] === 'FireRating' && p.args[2]?.value === 'REI60';
  }));
  return walls.length === 2 && types.size === 1 && !types.has(undefined) && sets.length === 1 &&
    step.get([...types][0])?.args[5]?.some(r => r.ref === sets[0].id) &&
    !step.of('IFCRELDEFINESBYPROPERTIES').some(r => r.args[4]?.some(v => walls.some(w => w.id === v.ref)) &&
      step.get(r.args[5])?.args[2] === 'Pset_WallCommon' &&
      step.get(r.args[5])?.args[4]?.some(ref => step.get(ref)?.args[0] === 'FireRating'));
}
export function layerUsage(step, wall, thicknesses) {
  const rel = step.of('IFCRELASSOCIATESMATERIAL').find(r => r.args[4]?.some(v => v.ref === wall?.id));
  const usage = step.get(rel?.args[5]);
  const set = usage?.type === 'IFCMATERIALLAYERSETUSAGE' ? step.get(usage.args[0]) : null;
  const layers = set?.args[0]?.map(r => step.get(r)?.args[1]) ?? [];
  return layers.length === thicknesses.length && layers.every((v,i) => Math.abs(v-thicknesses[i]) < .002);
}
export function gridCarriedColumn(before, after) {
  const cols = before.of('IFCCOLUMN');
  const grids = before.of('IFCGRID');
  const gridMoved = grids.length === 1 && after.of('IFCGRID').length === 1 && grids.every(g => {
    const next = after.of('IFCGRID').find(n => n.args[0] === g.args[0]);
    if (!next) return false;
    const a = before.placement(g.id).origin, b = after.placement(next.id).origin;
    return Math.abs(b[0]-a[0]-1) <= .005 && Math.abs(b[1]-a[1]) <= .005 && Math.abs(b[2]-a[2]) <= .005;
  });
  return gridMoved && cols.length > 0 && after.of('IFCCOLUMN').length === cols.length && cols.every(c => {
    const next = after.of('IFCCOLUMN').find(n => n.args[0] === c.args[0]);
    const bound = next && [after.get(next.args[5]), after.get(after.get(next.args[5])?.args[0])].some(p => p?.type === 'IFCGRIDPLACEMENT');
    const a = before.placement(c.id).origin, b = next && after.placement(next.id).origin;
    return bound && Math.abs(b[0]-a[0]-1) <= .005 && Math.abs(b[1]-a[1]) <= .005 && Math.abs(b[2]-a[2]) <= .005;
  });
}
export function scheduleTotal(text) {
  const clean = text.trim().replace(/\s*m(?:²|³|2|3)?$/, '').replace(/,/g, '');
  return /^[-+]?\d+(?:\.\d+)?$/.test(clean) ? Number(clean) : NaN;
}

/** Follow occurrence assignment to the actual layer materials; unrelated definitions do not count. */
export function assignedLayerMaterials(step, wallId) {
  return step.of('IFCRELASSOCIATESMATERIAL')
    .filter(r => r.args[4]?.some(v => v.ref === wallId))
    .flatMap(r => {
      const usage = step.get(r.args[5]);
      if (usage?.type !== 'IFCMATERIALLAYERSETUSAGE') return [];
      const set = step.get(usage.args[0]);
      if (set?.type !== 'IFCMATERIALLAYERSET') return [];
      return (set.args[0] ?? []).map(ref => step.get(step.get(ref)?.args[0])?.args[0]);
    });
}

/** Missing or empty review content cannot demonstrate a readable change summary. */
export function plainLanguageReview(text) {
  return typeof text === 'string' && /\bNew\s+IfcWall\s+#\d+\b/i.test(text) &&
    /\bEntity created\b/i.test(text) && !/#\d+\s*=\s*IFC/i.test(text);
}

const near = (a,b,t=.03) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a-b)<=t;
const point = (a,b) => !!a && !!b && a.every((v,i)=>near(v,b[i]));
export function alignedWalls(axes) {
  return axes.length===2 && [3,6].every(y => axes.filter(w => near(w.start[1],y) && near(w.end[1],y) && near(w.start[0],0)).length===1);
}
export function trimmedWalls(axes) {
  const walls=axes.filter(w => near(w.start[1],3) && near(w.end[1],3));
  return walls.length>0 && walls.every(w => Math.max(w.start[0],w.end[0])<=3.03) &&
    walls.some(w => point(w.start,[0,3]) && point(w.end,[3,3]));
}
export function wallsAtElevation(walls,elevation) {
  return walls.length>0 && walls.every(w=>near(w.z,elevation,.001));
}
export function rotatedWall(before,after,pivot) {
  const turn = p => [pivot[0]-(p[1]-pivot[1]),pivot[1]+(p[0]-pivot[0])];
  return !!before && !!after && point(after.start,turn(before.start)) && point(after.end,turn(before.end)) && near(after.z,before.z,.001);
}
export function arrayWalls(axes) {
  const walls=axes.filter(w=>w.start[1]>9);
  return walls.length===3 && [10,11.5,13].every(y=>walls.filter(w=>point(w.start,[0,y]) && point(w.end,[4,y]) && near(w.z,0,.001)).length===1);
}
export function typedRoomAxes(axes) {
  const corners=[[0,0],[5,0],[5,4],[0,4],[0,0]];
  return axes.length===4 && axes.every((w,i)=>point(w.start,corners[i]) && point(w.end,corners[i+1]));
}
export function typedSlab(q) {
  return near(q.Length,5,.001) && near(q.Depth,4,.001) && near(q.GrossArea,20,.001);
}
