/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { readFileSync } from 'node:fs';
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
