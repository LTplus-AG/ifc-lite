/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// #9314: every copied wall must retain a valid top constraint.
export function copiedWallAttachments(meta, records) {
  let checked=0, wrong=0;
  const checkedWalls=new Set();
  const copiedIds=new Set(meta.expected.filter(e=>e.kind==='copied'||e.copied).map(e=>e.expressId));
  for(const record of records.values()) {
    if(!record.startsWith('IFCRELDEFINESBYPROPERTIES(')) continue;
    const rel=record.match(/\(([^()]*)\),#(\d+)\)$/); if(!rel) continue;
    const ids=[...rel[1].matchAll(/#(\d+)/g)].map(m=>Number(m[1])).filter(n=>copiedIds.has(n)&&records.get(n)?.startsWith('IFCWALL('));
    const pset=records.get(Number(rel[2])); if(!ids.length||!pset?.includes("'IfcLite_StoreyAttachment'")) continue;
    const constraint=[...pset.matchAll(/#(\d+)/g)].map(m=>records.get(Number(m[1]))).find(v=>v?.includes("'TopConstraint'"));
    const guid=constraint?.match(/IFCLABEL\('([^']+)'\)/)?.[1];
    for(const entityId of ids) {
    const e=meta.expected.find(e=>e.expressId===entityId);
    const next=meta.levels[e.level!==undefined?e.level+1:meta.levels.findIndex(s=>Math.abs(s.elevation-e.min)<0.01)+1];
    checkedWalls.add(entityId); checked++; if(guid!=='NextStoreyAbove'&&guid!==next?.GlobalId) wrong++;
    }
  }
  const copiedWalls=[...copiedIds].filter(id=>records.get(id)?.startsWith('IFCWALL('));
  const missing=copiedWalls.filter(id=>!checkedWalls.has(id)).length;
  return {checked,wrong,missing,copiedWalls:copiedWalls.length,copiedCount:copiedIds.size};
}
