/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as oracle from './measured-oracles.mjs';
import { readStep } from './step.mjs';
const axis = (start,end,z=0) => ({start,end,z,length:Math.hypot(end[0]-start[0],end[1]-start[1])});

test('#9919 classification must equal the authored identification', () => {
  const model = code => readStep(`DATA; #1=IFCWALL('w'); #2=IFCCLASSIFICATIONREFERENCE($,'${code}'); #3=IFCRELASSOCIATESCLASSIFICATION('r',$,$,$,(#1),#2); ENDSEC;`);
  assert.equal(oracle.classificationOf(model('EF_25_10'),1,'EF_25_10'),true);
  assert.equal(oracle.classificationOf(model('wrong'),1,'EF_25_10'),false);
});

test('#9919 Align preserves the reference x and identifies both walls by y', () => {
  assert.equal(oracle.alignedWalls([axis([0,3],[5,3]),axis([0,6],[5,6])]),true);
  assert.equal(oracle.alignedWalls([axis([1,3],[6,3]),axis([1,6],[6,6])]),false);
  assert.equal(oracle.alignedWalls([axis([0,3],[5,3]),axis([0,3],[5,3])]),false);
});

test('#9919 Trim rejects any retained wall segment beyond the boundary', () => {
  const kept = axis([0,3],[3,3]);
  assert.equal(oracle.trimmedWalls([kept]),true);
  assert.equal(oracle.trimmedWalls([kept,axis([3,3],[5,3])]),false);
  assert.equal(oracle.trimmedWalls([kept,kept]),false);
  assert.equal(oracle.trimmedWalls([]),false);
});

test('#9919 copied walls must match their containing storey elevation', () => {
  assert.equal(oracle.wallsAtElevation([axis([0,0],[5,0],6)],6),true);
  assert.equal(oracle.wallsAtElevation([axis([0,0],[5,0],3)],6),false);
  assert.equal(oracle.wallsAtElevation([],6),false);
});

test('#9919 signed rotation tracks the selected exported wall', () => {
  const before=axis([0,5],[4,5]);
  assert.equal(oracle.rotatedWall(before,axis([0,5],[0,9]),[0,5]),true);
  assert.equal(oracle.rotatedWall(before,axis([0,5],[0,1]),[0,5]),false);
  assert.equal(oracle.rotatedWall(before,undefined,[0,5]),false);
  assert.equal(oracle.rotatedWall(before,axis([2,3],[2,7]),[2,5]),true);
  assert.equal(oracle.rotatedWall(before,axis([0,5],[0,9]),[2,5]),false);
});

test('#9919 Array requires three exact positions with typed spacing', () => {
  const valid=[10,11.5,13].map(y=>axis([0,y],[4,y]));
  assert.equal(oracle.arrayWalls(valid),true);
  assert.equal(oracle.arrayWalls([10,12,14].map(y=>axis([0,y],[4,y]))),false);
  assert.equal(oracle.arrayWalls([...valid,axis([0,14.5],[4,14.5])]),false);
  assert.equal(oracle.arrayWalls([...valid,axis([0,8.5],[4,8.5])]),false);
});

test('#9919 typed wall angles must produce the intermediate room corners', () => {
  const corners=[[0,0],[5,0],[5,4],[0,4],[0,0]];
  assert.equal(oracle.typedRoomAxes(corners.slice(0,-1).map((p,i)=>axis(p,corners[i+1]))),true);
  assert.equal(oracle.typedRoomAxes(Array.from({length:4},()=>({start:[],end:[]}))),false);
  const flat=[[0,0],[5,0],[9,0],[4,0],[0,0]];
  assert.equal(oracle.typedRoomAxes(flat.slice(0,-1).map((p,i)=>axis(p,flat[i+1]))),false);
});

test('#9919 a matching slab area cannot replace typed Length and Depth', () => {
  assert.equal(oracle.typedSlab({Length:5,Depth:4,GrossArea:20}),true);
  for(const [Length,Depth] of [[10,2],[4,5]]) assert.equal(oracle.typedSlab({Length,Depth,GrossArea:20}),false);
});

test('#9919 every loop join must connect its actual exported corner', async () => {
  const { fourWallJoins, wallEndpointsJoined } = await import('./oracles.mjs');
  const corners=[[0,0],[5,0],[5,4],[0,4],[0,0]];
  const walls=[1,2,3,4].map((id,i)=> {
    const n=100+i*10, [x,y]=corners[i], [ex,ey]=corners[i+1];
    return `#${id}=IFCWALL('w${id}',$,$,$,$,$,#${n},$,$);
#${n}=IFCPRODUCTDEFINITIONSHAPE($,$,(#${n+1}));
#${n+1}=IFCSHAPEREPRESENTATION($,'Axis','Curve2D',(#${n+2}));
#${n+2}=IFCPOLYLINE((#${n+3},#${n+4}));
#${n+3}=IFCCARTESIANPOINT((${x},${y}));
#${n+4}=IFCCARTESIANPOINT((${ex},${ey}));`;
  }).join('\n');
  const rel=(id,a,b)=>`#${id}=IFCRELCONNECTSPATHELEMENTS('r${id}',$,$,$,$,#${a},#${b},$,$,.ATSTART.,.ATEND.);`;
  const model=(pairs,extra='',wallData=walls)=>readStep(`DATA; ${wallData}\n${pairs.map(([a,b],i)=>rel(i+10,a,b)).join('\n')}\n${extra} ENDSEC;`);
  const valid=[[1,2],[2,3],[3,4],[4,1]], wrong=[[1,3],[3,2],[2,4],[4,1]];
  for(const check of [fourWallJoins,wallEndpointsJoined]) {
    assert.equal(check(model(valid)),true);
    assert.equal(check(model(valid,rel(20,1,3))),false);
    assert.equal(check(model(wrong)),false);
    assert.equal(check(model(valid,'',walls.replace('((0,0))','((1e999,1e999))'))),false);
    const placement=`#200=IFCLOCALPLACEMENT(#203,#201); #201=IFCAXIS2PLACEMENT3D(#202,$,$); #202=IFCCARTESIANPOINT((0,0,-1e999)); #203=IFCLOCALPLACEMENT($,#204); #204=IFCAXIS2PLACEMENT3D(#205,$,$); #205=IFCCARTESIANPOINT((0,0,1e999));`;
    const placed=walls.replace("#1=IFCWALL('w1',$,$,$,$,$,#100", "#1=IFCWALL('w1',$,$,$,$,#200,#100");
    assert.equal(check(model(valid,placement,placed)),false);
  }
});

test('#9919 copied levels must stay at the requested +3 m and +6 m', () => {
  const walls=[3,6].map(z=>[axis([0,0],[5,0],z)]);
  assert.equal(oracle.copyLevelElevations([3,6],walls),true);
  assert.equal(oracle.copyLevelElevations([3,0],[walls[0],[axis([0,0],[5,0],0)]]),false);
});

test('#9919 Align translates the displaced wall without stretching it', () => {
  assert.equal(oracle.alignedWalls([axis([0,3],[5,3]),axis([0,6],[6,6])]),false);
});
test('#9919 disconnected coincident wall pairs cannot certify a four-corner loop', async () => {
  const {fourWallJoins}=await import('./oracles.mjs');
  const walls=[1,2,3,4].map(id=>{
    const n=id*10, y=id<=2?0:4;
    return `#${id}=IFCWALL('w${id}',$,$,$,$,$,#${n},$,$);
#${n}=IFCPRODUCTDEFINITIONSHAPE($,$,(#${n+1}));
#${n+1}=IFCSHAPEREPRESENTATION($,'Axis','Curve2D',(#${n+2}));
#${n+2}=IFCPOLYLINE((#${n+3},#${n+4}));
#${n+3}=IFCCARTESIANPOINT((0,${y}));
#${n+4}=IFCCARTESIANPOINT((5,${y}));`;
  }).join('\n');
  const joins=[[1,2,'ATSTART'],[1,2,'ATEND'],[3,4,'ATSTART'],[3,4,'ATEND']].map(([a,b,end],i)=>
    `#${100+i}=IFCRELCONNECTSPATHELEMENTS('r${i}',$,$,$,$,#${a},#${b},$,$,.${end}.,.${end}.);`).join('\n');
  assert.equal(fourWallJoins(readStep(`DATA; ${walls} ${joins} ENDSEC;`)),false);
});
