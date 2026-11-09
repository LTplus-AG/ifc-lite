/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { fields } from './fzk-oracle.mjs';
const refs=s=>[...(s||'').matchAll(/#(\d+)/g)].map(m=>Number(m[1]));
export function spaceAreas(text,spaceIds) {
  const records=new Map([...text.matchAll(/#(\d+)\s*=\s*([^;]+);/g)].map(m=>[Number(m[1]),m[2]]));
  return spaceIds.map(id=>{
    const values=[];
    for(const record of records.values()) {
      if(!record.startsWith('IFCRELDEFINESBYPROPERTIES(')) continue;
      const a=fields(record); if(!refs(a[4]).includes(id)) continue;
      for(const q of refs(a[5])) {
        const quantity=records.get(q); if(!quantity?.startsWith('IFCELEMENTQUANTITY(')) continue;
        for(const n of refs(fields(quantity).at(-1))) {
          const area=records.get(n); if(!area?.startsWith('IFCQUANTITYAREA(')) continue;
          const args=fields(area); if(args[0]==="'NetFloorArea'") values.push(Number(args[3]));
        }
      }
    }
    return values.length===1?values[0]:NaN;
  });
}
export function copyCoverage(plans,text) {
  const contained=new Map();
  for(const rel of text.matchAll(/IFCRELCONTAINEDINSPATIALSTRUCTURE\([^;]*?\(([^()]*)\),#(\d+)\);/g))
    for(const id of refs(rel[1])) contained.set(id,Number(rel[2]));
  const expected=plans.reduce((n,p)=>n+p.count,0), returned=plans.reduce((n,p)=>n+p.ids.length,0);
  const present=plans.reduce((n,p)=>n+p.ids.filter(id=>contained.get(id)===p.storeyId).length,0);
  return {expected,returned,present,ok:expected===returned&&returned===present&&new Set(plans.flatMap(p=>p.ids)).size===expected};
}
