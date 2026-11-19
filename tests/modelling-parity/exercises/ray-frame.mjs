/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Infer the common IFC-world -> GLB translation using unchanged wall axes.
 * Horizontal body centres avoid treating wall thickness as a translation.
 * IFC Z-up maps to GLB Y-up [x,z,-y]. Medians tolerate local join extents.
 */
export function rayFrameShift(axes,rows) {
  const deltas=axes.flatMap(a=>{
    const row=rows.find(r=>r.expressId===a.id);
    if(!row) return [];
    return [[(row.min[0]+row.max[0])/2-(a.start[0]+a.end[0])/2,
      row.min[1]-a.z,(row.min[2]+row.max[2])/2+(a.start[1]+a.end[1])/2]];
  }).filter(delta=>delta.every(Number.isFinite));
  if(!deltas.length) throw new Error('Cannot resolve GLB ray frame: no matching wall geometry');
  return [0,1,2].map(k=>deltas.map(d=>d[k]).sort((a,b)=>a-b)[Math.floor(deltas.length/2)]);
}
