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
});

test('#9919 Array requires three exact positions with typed spacing', () => {
  const valid=[10,11.5,13].map(y=>axis([0,y],[4,y]));
  assert.equal(oracle.arrayWalls(valid),true);
  assert.equal(oracle.arrayWalls([10,12,14].map(y=>axis([0,y],[4,y]))),false);
  assert.equal(oracle.arrayWalls([...valid,axis([0,14.5],[4,14.5])]),false);
});

test('#9919 typed wall angles must produce the intermediate room corners', () => {
  const corners=[[0,0],[5,0],[5,4],[0,4],[0,0]];
  assert.equal(oracle.typedRoomAxes(corners.slice(0,-1).map((p,i)=>axis(p,corners[i+1]))),true);
  const flat=[[0,0],[5,0],[9,0],[4,0],[0,0]];
  assert.equal(oracle.typedRoomAxes(flat.slice(0,-1).map((p,i)=>axis(p,flat[i+1]))),false);
});

test('#9919 a matching slab area cannot replace typed Length and Depth', () => {
  assert.equal(oracle.typedSlab({Length:5,Depth:4,GrossArea:20}),true);
  for(const [Length,Depth] of [[10,2],[4,5]]) assert.equal(oracle.typedSlab({Length,Depth,GrossArea:20}),false);
});

test('#9919 four-wall loops reject an additional non-neighbour join', async () => {
  const { fourWallJoins } = await import('./oracles.mjs');
  const walls=[1,2,3,4].map(i=>`#${i}=IFCWALL('w${i}');`).join('\n');
  const rel=(id,a,b)=>`#${id}=IFCRELCONNECTSPATHELEMENTS('r${id}',$,$,$,$,#${a},#${b},$,$,.ATSTART.,.ATEND.);`;
  const loop=[1,2,3,4].map((a,i)=>rel(i+10,a,a===4?1:a+1)).join('\n');
  const model=extra=>readStep(`DATA; ${walls}\n${loop}\n${extra} ENDSEC;`);
  assert.equal(fourWallJoins(model('')),true);
  assert.equal(fourWallJoins(model(rel(20,1,3))),false);
});
