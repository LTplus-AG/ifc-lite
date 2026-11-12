/** Export-level oracles for #9296 round 5; every relation is checked against the target. */
export const typeOf = (step, id) => step.of('IFCRELDEFINESBYTYPE').find(r => r.args[4]?.some(v => v.ref === id))?.args[5]?.ref;
export function classificationOf(step, id) {
  return step.of('IFCRELASSOCIATESCLASSIFICATION').some(r => r.args[4]?.some(v => v.ref === id) && step.get(r.args[5])?.type === 'IFCCLASSIFICATIONREFERENCE');
}
export function inheritedFireRating(step, walls) {
  const types = new Set(walls.map(w => typeOf(step, w.id)));
  const sets = step.of('IFCPROPERTYSET').filter(ps => ps.args[2] === 'Pset_WallCommon' && ps.args[4]?.some(r => {
    const p = step.get(r); return p?.args[0] === 'FireRating' && p.args[2]?.value === 'REI60';
  }));
  return walls.length === 2 && types.size === 1 && !types.has(undefined) && sets.length === 1 &&
    step.get([...types][0])?.args[5]?.some(r => r.ref === sets[0].id) &&
    !step.of('IFCRELDEFINESBYPROPERTIES').some(r => r.args[5]?.ref === sets[0].id && r.args[4]?.some(v => walls.some(w => w.id === v.ref)));
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
  return cols.length > 0 && cols.every(c => {
    const next = after.of('IFCCOLUMN').find(n => n.args[0] === c.args[0]);
    const bound = next && [after.get(next.args[5]), after.get(after.get(next.args[5])?.args[0])].some(p => p?.type === 'IFCGRIDPLACEMENT');
    const a = before.placement(c.id).origin, b = next && after.placement(next.id).origin;
    return bound && Math.abs(b[0]-a[0]-1) <= .005 && Math.abs(b[1]-a[1]) <= .005;
  });
}
export function scheduleTotal(text) {
  const clean = text.trim().replace(/\s*m(?:²|³|2|3)?$/, '').replace(/,/g, '');
  return /^[-+]?\d+(?:\.\d+)?$/.test(clean) ? Number(clean) : NaN;
}
