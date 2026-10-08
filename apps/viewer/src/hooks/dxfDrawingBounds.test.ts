/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Drawing2D } from '@ifc-lite/drawing-2d';
async function loadDrawingBounds() {
  const module = await import('./dxfDrawingBounds').catch((error: unknown) => {
    if ((error as { code?: string }).code !== 'ERR_MODULE_NOT_FOUND') throw error;
    return null;
  });
  assert.ok(module, 'mapped DXF drawing bounds must be available');
  return module;
}
const drawing:Drawing2D={config:{plane:{axis:'z',position:0,flipped:false},projectionDepth:10,includeHiddenLines:false,creaseAngle:30,scale:100},lines:[],cutPolygons:[],projectionPolygons:[],bounds:{min:{x:0,y:0},max:{x:0,y:0}},stats:{cutLineCount:0,projectionLineCount:0,hiddenLineCount:0,silhouetteLineCount:0,polygonCount:0,totalTriangles:0,processingTimeMs:0}};
test('underlay-only fit uses mapped landmarks without changing generated bounds (#6615)',async()=>{
  const { drawingWithDxfBounds } = await loadDrawingBounds();
  const reference={id:'cad',opacity:1,lines:[{points:[{x:100,y:200},{x:104,y:203}],closed:false,color:'#000'}],fills:[],texts:[]};
  const result=drawingWithDxfBounds(drawing,[reference])!;
  assert.deepEqual(result.bounds,{min:{x:100,y:200},max:{x:104,y:203}});
  assert.deepEqual(drawing.bounds,{min:{x:0,y:0},max:{x:0,y:0}});
  const withRaster=drawingWithDxfBounds({...drawing,bounds:{min:{x:10,y:20},max:{x:20,y:30}}},[reference],true)!;
  assert.deepEqual(withRaster.bounds,{min:{x:10,y:20},max:{x:104,y:203}});
});

test('reference-only bounds supply no model centre, while a finite one-dimensional cut does (#6615)', async () => {
  const { drawingModelCenter } = await loadDrawingBounds();
  assert.equal(drawingModelCenter({...drawing,bounds:{min:{x:100,y:200},max:{x:104,y:203}}}),null);
  const line: Drawing2D['lines'][number] = {line:{start:{x:1,y:2},end:{x:1,y:10}},category:'cut',visibility:'visible',entityId:1,ifcType:'IfcWall',modelIndex:0,depth:0};
  assert.deepEqual(drawingModelCenter({...drawing,lines:[line],bounds:{min:{x:1,y:2},max:{x:1,y:10}}}),{x:1,y:6});
  assert.equal(drawingModelCenter({...drawing,lines:[line],bounds:{min:{x:0,y:0},max:{x:0,y:0}}}),null);
  assert.equal(drawingModelCenter({...drawing,lines:[line],bounds:{min:{x:NaN,y:0},max:{x:1,y:1}}}),null);
});


test('multiline DXF fit encloses every rotated glyph row and alignment (#6615)', async () => {
  const { drawingWithDxfBounds } = await loadDrawingBounds();
  for (const angle of [0, Math.PI / 3]) {
    const ux = Math.cos(angle), uy = Math.sin(angle);
    for (const align of ['left', 'center', 'right'] as const) {
      const text = {x:100,y:200,dirX:ux*3,dirY:uy*3,height:1,text:'AAAA\nB\nCCC\nD',align,valign:'baseline' as const,color:'#000'};
      const result = drawingWithDxfBounds(drawing,[{id:'text',opacity:1,lines:[],fills:[],texts:[text]}]);
      assert.ok(result);
      for (const direction of [-1,1]) {
        for (const [row,line] of text.text.split('\n').entries()) {
          const left = align === 'right' ? -line.length : align === 'center' ? -line.length / 2 : 0;
          for (const x of [left,left+line.length]) for (const glyphY of [-1,1]) {
            const y = direction*row*1.3+glyphY;
            const point = {x:text.x+ux*x-uy*y,y:text.y+uy*x+ux*y};
            assert.ok(point.x >= result.bounds.min.x-1e-10 && point.x <= result.bounds.max.x+1e-10);
            assert.ok(point.y >= result.bounds.min.y-1e-10 && point.y <= result.bounds.max.y+1e-10);
          }
        }
      }
      if (angle === 0) assert.equal(result.bounds.max.x-result.bounds.min.x,4,'width uses the longest row, not the total character count');
    }
  }
});
