/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Two opposing slope groups must meet at one high ridge with disjoint plan interiors. */
export function opposingRoofPlans(triangles) {
  const groups=[[],[]]; let direction;
  for (const triangle of triangles) {
    const [a,b,c]=triangle, u=b.map((v,i)=>v-a[i]),v=c.map((n,i)=>n-a[i]);
    const n=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]];
    const horizontal=Math.hypot(n[0],n[2]);
    if(n[1]<=1e-8 || horizontal<=1e-8) continue;
    const normal=[n[0]/horizontal,n[2]/horizontal]; direction ??= normal;
    const dot=normal[0]*direction[0]+normal[1]*direction[1];
    if(Math.abs(dot)<.99) return false;
    groups[dot>0?0:1].push(...triangle);
  }
  if(groups.some(g=>!g.length)) return false;
  const project=p=>[p[0]*direction[0]+p[2]*direction[1],-p[0]*direction[1]+p[2]*direction[0],p[1]];
  const bands=groups.map(g=>g.map(project)).map(points=>({points,
    min:Math.min(...points.map(p=>p[0])),max:Math.max(...points.map(p=>p[0])),
    alongMin:Math.min(...points.map(p=>p[1])),alongMax:Math.max(...points.map(p=>p[1])),
    low:Math.min(...points.map(p=>p[2])),
  })).sort((a,b)=>a.min-b.min);
  const [a,b]=bands, tolerance=.001;
  if(Math.abs(a.max-b.min)>tolerance || Math.abs(a.alongMin-b.alongMin)>tolerance || Math.abs(a.alongMax-b.alongMax)>tolerance) return false;
  const ridge=band=>band.points.filter(p=>Math.abs(p[0]-a.max)<=tolerance);
  const left=ridge(a),right=ridge(b);
  const span=points=>[Math.min(...points.map(p=>p[1])),Math.max(...points.map(p=>p[1]))];
  const [leftFrom,leftTo]=span(left),[rightFrom,rightTo]=span(right);
  const heights=[...left,...right].map(p=>p[2]);
  return leftTo-leftFrom>tolerance && rightTo-rightFrom>tolerance &&
    Math.abs(leftFrom-rightFrom)<=tolerance && Math.abs(leftTo-rightTo)<=tolerance &&
    Math.max(...heights)-Math.min(...heights)<=tolerance &&
    Math.min(...heights)>Math.max(a.low,b.low)+tolerance;
}
