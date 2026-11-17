/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Camera } from './camera.js';
import { AnnotationPicker, resolveAnnotationPick } from './annotation-picking.js';
import type { PickClipState } from './types.js';

function setup(offset = 0) {
  const camera = new Camera();
  camera.setPosition(offset, 0, 10);
  camera.setTarget(offset, 0, 0);
  const picker = new AnnotationPicker();
  picker.setLines({ origin: [offset,0,0], localVertices: new Float32Array([-1,0,0,1,0,0]), ownerIds: new Uint32Array([71]) }, true);
  const pick = (x = 100, y = 100, clip?: PickClipState) => picker.pick(camera,x,y,200,200,undefined,clip);
  return { camera, picker, pick };
}

test('#8783 line tolerance is four CSS pixels in both projections and at national-grid origins', () => {
  for (const offset of [0, 5_000_000]) for (const mode of ['perspective','orthographic'] as const) {
    const {camera,pick} = setup(offset);
    camera.setProjectionMode(mode);
    assert.equal(resolveAnnotationPick(pick(100,103),null)?.expressId,71);
    assert.equal(resolveAnnotationPick(pick(100,105),null),null);
    assert.equal(resolveAnnotationPick(pick(),{expressId: 2,worldXYZ:{x:offset,y:0,z:1}})?.expressId,2);
    assert.equal(resolveAnnotationPick(pick(),{expressId: 2,worldXYZ:{x:offset,y:0,z:-1}})?.expressId,71);
  }
});

test('#8783 clipped line interiors, reversed planes and clip boxes cannot be picked', () => {
  const {camera,pick,picker} = setup();
  const clip: PickClipState = {sectionPlane:{normal:[1,0,0],distance:-.2,flipped:false}};
  assert.equal(resolveAnnotationPick(pick(100,100,clip),null),null);
  const p = camera.projectToScreen({x:-.5,y:0,z:0},200,200)!;
  assert.equal(resolveAnnotationPick(pick(p.x,p.y,clip),null)?.expressId,71);
  clip.sectionPlane!.flipped = true;
  assert.equal(resolveAnnotationPick(pick(p.x,p.y,clip),null),null);
  assert.equal(resolveAnnotationPick(pick(100,100,{clipBox:{enabled:true,min:[-.1,-1,-1],max:[.1,1,1]}}),null)?.expressId,71);
  assert.equal(resolveAnnotationPick(picker.pick(camera,100,100,200,200,{hiddenIds:new Set([71])}),null),null);
  assert.equal(resolveAnnotationPick(picker.pick(camera,100,100,200,200,{isolatedIds:new Set()}),null),null);
});

test('#8783 replacement and clear invalidate in-flight picks and leave no stale geometry', () => {
  const {pick,picker} = setup();
  const pending = pick();
  picker.clear();
  assert.equal(resolveAnnotationPick(pending,null),null);
  assert.equal(pick(),null);
  picker.setLines({origin:[0,0,0],localVertices:new Float32Array([-1,0,0,1,0,0])},true);
  assert.equal(pick(),null,'reference lines without ownership do not participate');
});

test('#8783 fill uses triangulated holes and clips the hit, not its anchor', () => {
  const {camera,picker} = setup();
  picker.clear();
  camera.setPosition(0,10,0);
  camera.setTarget(0,0,0);
  picker.setFills([{ownerId:82,points:new Float32Array([-2,-2,2,-2,2,2,-2,2,-.5,-.5,-.5,.5,.5,.5,.5,-.5]),
    holesOffsets:new Uint32Array([4]),worldY:0,color:[1,0,0,1],sectionClipped:true}]);
  const pickAt = (x:number,z:number,clip?:PickClipState) => {
    const p = camera.projectToScreen({x,y:0,z},200,200)!;
    return resolveAnnotationPick(picker.pick(camera,p.x,p.y,200,200,undefined,clip),null);
  };
  assert.equal(pickAt(0,0),null,'hole');
  assert.equal(pickAt(1,0)?.expressId,82);
  assert.equal(pickAt(1,0,{sectionPlane:{normal:[1,0,0],distance:0,flipped:false}}),null);
  assert.equal(pickAt(-1,0,{sectionPlane:{normal:[1,0,0],distance:0,flipped:false}})?.expressId,82);
});

test('#8783 labels use actual glyph quads, screen-size clamp and anchor clipping', () => {
  const {camera,picker} = setup();
  picker.clear();
  picker.setGlyphs([{ownerId:93,anchor:[0,0,0],right:[1,0,0],offsetSize:[0,0,1,1],
    capHeight:1,targetPx:14,anchored:true,billboard:false,sectionClipped:true}]);
  assert.equal(resolveAnnotationPick(picker.pick(camera,107,93,200,200),null)?.expressId,93);
  assert.equal(resolveAnnotationPick(picker.pick(camera,117,93,200,200),null),null);
  assert.equal(resolveAnnotationPick(picker.pick(camera,107,93,200,200,undefined,
    {sectionPlane:{normal:[0,0,1],distance:-1,flipped:false}}),null),null);
});

test('#8783 annotation-free picking performs no camera work', () => {
  const picker = new AnnotationPicker();
  const camera = new Proxy({} as Camera,{get(){throw new Error('camera accessed');}});
  assert.equal(picker.pick(camera,0,0,200,200),null);
});
