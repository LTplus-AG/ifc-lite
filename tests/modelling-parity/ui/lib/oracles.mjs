/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { readFileSync } from 'node:fs';
import { judgeRoof } from '../../probes/sdk/lib/roof-oracle.mjs';
export function hardwareAdapter(a) {
  return !!a && !a.isFallbackAdapter && !a.info?.isFallbackAdapter && !a.fallback && !/swiftshader|llvmpipe|lavapipe|microsoft basic render/i.test(`${a.architecture} ${a.description} ${a.info?.architecture} ${a.info?.description}`);
}
export function loadTarget(file,fallback) {
  let text;
  try { text=readFileSync(file,'utf8'); }
  catch(error) {
    if(error.code==='ENOENT') return {...fallback,from:'embedded copy of f2-fzk-haus-target.json (PR #9304)'};
    throw error;
  }
  const value=JSON.parse(text);
  if(!value || !Array.isArray(value.storeys) || !Array.isArray(value.spaces) || !value.tolerances || !value.roof || !value.footprint || !value.totals) throw new Error('Malformed FZK target');
  return {...value,from:'tests/modelling-parity/references/f2-fzk-haus-target.json'};
}
export function ownOpenings(step,fillers) {
  const ids=fillers.map(e=>{
    const fills=step.of('IFCRELFILLSELEMENT').filter(r=>r.args?.[5]?.ref===e.id);
    if(fills.length!==1) return null;
    const id=fills[0].args?.[4]?.ref;
    return step.get({ref:id})?.type==='IFCOPENINGELEMENT'?id:null;
  });
  return ids.every(id=>id!==null) && new Set(ids).size===fillers.length;
}
export function themedResult(result,theme) {
  return {...result,id:`${result.id}.${theme}`,theme};
}


export function wallPropertySets(step) {
  return step.of('IFCWALL').map((wall) => step.of('IFCRELDEFINESBYPROPERTIES')
    .filter((rel) => rel.args?.[4]?.some((ref) => ref.ref === wall.id))
    .map((rel) => step.get(rel.args?.[5]))
    .filter((set) => set?.type === 'IFCPROPERTYSET')
    .map((set) => set.args?.[2]));
}

/** Elements not contained directly in an IfcBuildingStorey (a building or site container doesn't count). */
export function uncontainedInStoreys(step, elements) {
  const contained = step.containment();
  const storeys = new Set(step.of('IFCBUILDINGSTOREY').map((s) => s.id));
  return elements.filter((e) => !storeys.has(contained.get(e.id))).length;
}

export function wallQuantityCoverage(step) {
  return step.of('IFCWALL').map((wall) => step.quantities(wall.id));
}

export function assignedTypes(step, elements) {
  return elements.every((element) => step.of('IFCRELDEFINESBYTYPE').some((rel) =>
    rel.args?.[4]?.some((ref) => ref.ref === element.id) &&
    step.get(rel.args?.[5])?.type === element.type + 'TYPE'));
}
export function uniqueWallJoins(step) {
  const walls = new Set(step.of('IFCWALL').map((w) => w.id));
  return new Set(step.of('IFCRELCONNECTSPATHELEMENTS').flatMap((rel) => {
    const a = rel.args?.[5]?.ref, b = rel.args?.[6]?.ref;
    return a !== b && walls.has(a) && walls.has(b) ? [[`${a}:${rel.args?.[10]?.enum ?? 'unknown'}`, `${b}:${rel.args?.[9]?.enum ?? 'unknown'}`].sort().join('|')] : [];
  })).size;
}

/** Counts alone cannot establish that every wall endpoint is joined. */
export function wallEndpointsJoined(step) {
  const walls = new Set(step.of('IFCWALL').map(w => w.id));
  if (!walls.size) return false;
  const axes=new Map(step.wallAxes().map(w=>[w.id,w]));
  if (walls.size===4 && step.of('IFCRELCONNECTSPATHELEMENTS').length!==4) return false;
  const joined = new Set();
  for (const rel of step.of('IFCRELCONNECTSPATHELEMENTS')) {
    const a = rel.args?.[5]?.ref, b = rel.args?.[6]?.ref;
    if (a === b || !walls.has(a) || !walls.has(b)) return false;
    const endpoint=(id,kind)=>kind==='ATSTART'?axes.get(id)?.start:kind==='ATEND'?axes.get(id)?.end:undefined;
    const p=endpoint(a,rel.args?.[10]?.enum), q=endpoint(b,rel.args?.[9]?.enum);
    if (!p || !q || p.length!==2 || q.length!==2 || ![...p,...q,axes.get(a).z,axes.get(b).z].every(Number.isFinite) || Math.hypot(p[0]-q[0],p[1]-q[1])>.001 || Math.abs(axes.get(a).z-axes.get(b).z)>.001) return false;
    for (const [id, endpoint] of [[a, rel.args?.[10]?.enum], [b, rel.args?.[9]?.enum]]) {
      if (endpoint === 'ATSTART' || endpoint === 'ATEND') joined.add(`${id}:${endpoint}`);
    }
  }
  return [...walls].every(id => joined.has(`${id}:ATSTART`) && joined.has(`${id}:ATEND`));
}

export function hasDwgDownload(download) {
  return !!download?.bytes && /^AC10[0-9]{2}$/.test(download.bytes.subarray(0, 6).toString());
}

export function copiedPlansMatch(reference, floors) {
  if (!reference.length) return false;
  return floors.every((walls) => {
    if (walls.length !== reference.length) return false;
    const pending = [...reference];
    return walls.every((wall) => {
      const i = pending.findIndex((source) => ['start','end'].every((key) =>
        Math.hypot(source[key][0]-wall[key][0], source[key][1]-wall[key][1]) <= 1e-3));
      if (i < 0) return false;
      pending.splice(i,1);
      return true;
    });
  });
}

/** Judge only the exported roof, using the SDK oracle's sampled envelope and volume. */
export function roofGeometry(step, meshes, expected) {
  const roofs = [...step.of('IFCROOF'), ...step.of('IFCSLAB').filter(e => e.args?.[8]?.enum === 'ROOF')];
  if (roofs.length !== 1) return `expected one roof, found ${roofs.length}`;
  return judgeRoof(meshes.get(roofs[0].id)?.parts ?? [], expected);
}

/** Complete bipartite assignment: export ordering must not change the verdict. */
export function matchAreas(expected, actual, tolerance) {
  if (expected.length !== actual.length || ![...expected,...actual].every(Number.isFinite)) return false;
  const owner = new Map();
  const assign = (i, visited) => {
    for (let j = 0; j < actual.length; j++) {
      if (visited.has(j) || Math.abs(actual[j]-expected[i]) > expected[i]*tolerance) continue;
      visited.add(j);
      if (!owner.has(j) || assign(owner.get(j), visited)) { owner.set(j,i); return true; }
    }
    return false;
  };
  return expected.every((_,i) => assign(i,new Set()));
}

/** Exactly four distinct corner joins are required for the authored four-wall loop. */
export function fourWallJoins(step) {
  const walls=step.of('IFCWALL'), joins=step.of('IFCRELCONNECTSPATHELEMENTS');
  if(walls.length!==4 || joins.length!==4 || uniqueWallJoins(step)!==4 || !wallEndpointsJoined(step)) return false;
  const visited=new Set(), pending=[walls[0].id];
  while(pending.length) {
    const id=pending.pop();
    if(visited.has(id)) continue;
    visited.add(id);
    for(const rel of joins) {
      const a=rel.args[5].ref,b=rel.args[6].ref;
      if(a===id) pending.push(b);
      if(b===id) pending.push(a);
    }
  }
  if(visited.size!==4) return false;
  const corners=[];
  for(const wall of step.wallAxes()) for(const point of [wall.start,wall.end]) {
    if(!corners.some(p=>Math.hypot(p[0]-point[0],p[1]-point[1],p[2]-wall.z)<=.001)) corners.push([...point,wall.z]);
  }
  return corners.length===4;
}
