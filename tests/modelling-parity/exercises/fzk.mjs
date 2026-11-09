/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { readFileSync } from 'node:fs';
// Pinned target from PR #9304, head 70e17347d135456bfec0d7be7361adee5bc383d8.
// The PR branch is parity/r0-l5-references; no merge dependency is required.
export const target=JSON.parse(readFileSync(new URL('./f2-fzk-haus.target',import.meta.url),'utf8'));
export function buildFzk(bim,{M,step,add,expected,openings}) {
  const levels=()=>bim.store.listStoreyLevels(M).slice().sort((a,b)=>a.elevation-b.elevation);
  const ground=levels()[0];
  step('rename-ground','storeys',()=>bim.store.renameStorey({modelId:M,expressId:ground.expressId},target.storeys[0].name));
  add('attic','storeys',()=>bim.store.addStorey(M,{Name:target.storeys[1].name,Elevation:2.7}));
  const attic=levels()[1], walls=[];
  for(let level=0;level<2;level++) {
    const s=level?attic:ground, corners=[[0.125,0.125],[11.875,0.125],[11.875,9.875],[0.125,9.875]];
    walls[level]=corners.map((p,i)=>add(`L${level}-wall-${i}`,'wall-chains-autojoin',()=>bim.store.addWall(M,s.expressId,{Start:[...p,0],End:[...corners[(i+1)%4],0],Thickness:0.25,Height:2.7,Name:`FZK L${level} exterior ${i}`})));
    for(let i=0;i<4;i++) {
      const w=walls[level][i]; if(!w) continue;
      step(`L${level}-join-${i}`,'wall-chains-autojoin',()=>bim.store.joinWalls(M,w.expressId,walls[level][(i+1)%4].expressId));
      if(!level) step(`L0-attach-${i}`,'wall-top-base-constraints',()=>bim.mutate.setProperty(w,'IfcLite_StoreyAttachment','TopConstraint',attic.GlobalId,'IfcLabel'));
      expected.push({expressId:w.expressId,kind:'wall',min:level*2.7,max:(level+1)*2.7});
    }
    add(`L${level}-slab`,'slab-with-openings',()=>bim.store.addSlab(M,s.expressId,{Position:[0,level?0.84:0,0],Width:12,Depth:level?8.32:10,Thickness:0.2,ExtrudedDirection:[0,0,-1]}));
  }
  const partitions=[[[6,0.25],[6,9.75]],...Array.from({length:4},(_,i)=>[[i<2?0.25:7.425,3+(i%2)*3],[i<2?4.575:11.75,3+(i%2)*3]])];
  const inside=partitions.map(([a,b],i)=>add(`partition-${i}`,'wall-chains-autojoin',()=>bim.store.addWall(M,ground.expressId,{Start:[...a,0],End:[...b,0],Thickness:0.12,Height:2.7,Name:`FZK partition ${i}`})));
  const doorSizes=Object.entries(target.storeys[0].doors.widthXHeight).flatMap(([size,count])=>Array.from({length:count},()=>size.split('x').map(Number)));
  doorSizes.forEach(([Width,Height],i)=>add(`door-${i}`,'hosted-doors-windows-from-types',()=>bim.store.addHostedDoor(M,i===4?walls[0][0].expressId:inside[i+1]?.expressId||inside[0].expressId,{Offset:i===4?6:2,Width,Height})));
  openings.push({expressId:walls[0][0].expressId,x:6.125,z:1.1,adjacentOffset:2});
  for(const side of [1,2,3]) for(const offset of side===2?[2,6,10]:[2,5,8]) add(`window-L0-${side}-${offset}`,'hosted-doors-windows-from-types',()=>bim.store.addHostedWindow(M,walls[0][side].expressId,{Offset:offset,Sill:0.9,Width:2,Height:1.2}));
  for(const side of [0,2]) add(`window-L1-${side}`,'hosted-doors-windows-from-types',()=>bim.store.addHostedWindow(M,walls[1][side].expressId,{Offset:6,Sill:0.9,Width:1,Height:1}));
  openings.push({expressId:walls[0][2].expressId,x:9.875,z:1.5,adjacentOffset:1.5});
  const ys=[0.25,0.25];
  for(const space of target.spaces) {
    let Position,Width,Depth;
    if(space.storey===target.storeys[1].name) {Position=[0.3,0.3,0];Width=11.4;Depth=space.area/Width;}
    else {const column=['5','6','1'].includes(space.name)?0:1;Width=5.75;Depth=space.area/Width;Position=[column?6.125:0.125,ys[column],0];ys[column]+=Depth+0.06;}
    add(`space-${space.name}`,'rooms-with-area',()=>bim.store.addSpace(M,space.storey===target.storeys[0].name?ground.expressId:attic.expressId,{Position,Width,Depth,Height:2.7,Name:space.name,LongName:space.longName}));
  }
  for(let i=0;i<4;i++) add(`beam-${i}`,'columns-beams-on-grid-follow-levels',()=>bim.store.addBeam(M,i?attic.expressId:ground.expressId,{Start:[1,1+i*2,2.4],End:[11,1+i*2,2.4],Width:0.2,Height:0.3}));
  const stair=add('stair','stairs-railings',()=>bim.store.addStair(M,ground.expressId,{Position:[5,1,0],Direction:Math.PI/2,NumberOfRisers:15,RiserHeight:0.18,TreadLength:0.25,Width:1}));
  if(stair) expected.push({expressId:stair.expressId,kind:'stair',min:0,max:2.7});
  add('gable-roof-attempt','roof-by-footprint',()=>bim.store.addRoof(M,attic.expressId,{Position:[0,0,2.7],Width:12,Depth:10,Thickness:0.3,RoofType:'GABLE_ROOF',Slope:30}));
  // Exercise constraints without changing the reference's final occupied levels.
  for(const Height of [3,2.7]) step(`floor-height-${Height}`,'storeys',()=>bim.store.editStorey(M,{kind:'floorHeight',storeyId:ground.expressId,Height}));
  step('storey-elevations-oracle','storeys',()=>{for(const s of target.storeys) if(!levels().some(l=>l.Name===s.name&&Math.abs(l.elevation-s.elevation)<=target.tolerances.elevationM.value)) throw new Error(`Missing reference storey ${s.name} at ${s.elevation}`);});
}
