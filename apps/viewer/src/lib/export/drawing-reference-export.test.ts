/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { jsPDF } from 'jspdf';
import { exportToDXF, importDxf, parseDxf, type Drawing2D } from '@ifc-lite/drawing-2d';
// A production-only revert removes these newly added modules. Keep assertions
// runnable in that state; rethrow unrelated initialization failures.
function missingProductionModule(error: unknown): null {
  if (error && typeof error === 'object' && 'code' in error
    && (error.code === 'ERR_MODULE_NOT_FOUND' || error.code === 'MODULE_NOT_FOUND')) return null;
  throw error;
}
const rasterExports = await import('./drawing-raster-references.js').catch(missingProductionModule);
const vectorExports = await import('./drawing-vector-underlays.js').catch(missingProductionModule);
function snapshotDrawingReferences(...args: Parameters<NonNullable<typeof rasterExports>['snapshotDrawingReferences']>) {
  assert.ok(rasterExports, 'Committed raster export composition must be available.');
  return rasterExports.snapshotDrawingReferences(...args);
}
function buildRasterReferenceSvg(...args: Parameters<NonNullable<typeof rasterExports>['buildRasterReferenceSvg']>) {
  assert.ok(rasterExports, 'Four-corner SVG reference composition must be available.');
  return rasterExports.buildRasterReferenceSvg(...args);
}
function mappedDxfUnderlayOptions(...args: Parameters<NonNullable<typeof vectorExports>['mappedDxfUnderlayOptions']>) {
  assert.ok(vectorExports, 'Mapped CAD vector export must be available.');
  return vectorExports.mappedDxfUnderlayOptions(...args);
}
function drawDxfUnderlaysPdf(...args: Parameters<NonNullable<typeof vectorExports>['drawDxfUnderlaysPdf']>) {
  assert.ok(vectorExports, 'Vector PDF reference composition must be available.');
  return vectorExports.drawDxfUnderlaysPdf(...args);
}
import { appearanceAssets } from '@/lib/appearance/model-assets.js';
import { useViewerStore } from '@/store/index.js';
import { placementFrameKey } from '@/lib/model-placement/persistence.js';
import type { RegisteredAppearanceReference } from '@/lib/appearance/references/types.js';
import { dxfUnderlayToDrawing, type DxfUnderlayRenderData } from '@/hooks/useDxfUnderlay.js';
import type { DxfUnderlayState } from '@/store/slices/drawing2DSlice.js';

const owner = { kind: 'source' as const, id: 'reference-export-test' };
const png = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==', 'base64'));
afterEach(() => {
  useViewerStore.setState({ appearanceReferences: new Map() });
  appearanceAssets.releaseOwner(owner);
});
async function record(): Promise<RegisteredAppearanceReference> {
  const asset = await appearanceAssets.add(png, { owner });
  // Non-parallelogram registration is an explicit four-corner invariant.
  return { id: 'page', sourceId: 'source', assetId: asset.id, frameKey: placementFrameKey(useViewerStore.getState()),
    cornersIfcWorld: [[0,0,0],[4,0,0],[3,-2,0],[0,-3,0]], opacity: 0.5, visible: true, locked: false };
}
const vectors: DxfUnderlayRenderData[] = [{ id: 'elevation', opacity: 0.75,
  lines: [{ points: [{x:2,y:3},{x:6,y:7}], closed: false, color: '#ff0000' }], fills: [],
  texts: [{ x:2,y:3,dirX:1,dirY:0,height:0.2,text:'Elevation',color:'#000000',align:'left',valign:'baseline' }] }];

describe('section reference export composition (#6615)', () => {
  it('owns the committed bytes/placement after removal and releases its image lease', async () => {
    const reference = await record();
    useViewerStore.setState({ appearanceReferences: new Map([[reference.id,reference]]) });
    const snapshot = snapshotDrawingReferences(useViewerStore.getState(), { axis:'y',position:0,flipped:false });
    try {
      useViewerStore.setState({ appearanceReferences: new Map() });
      appearanceAssets.releaseOwner(owner);
      assert.ok(appearanceAssets.get(reference.assetId), 'in-flight export owns the removed asset');
      assert.equal(snapshot.references.length, 1);
      assert.equal(snapshot.references[0].href, `data:image/png;base64,${Buffer.from(png).toString('base64')}`);
      assert.equal(snapshot.references[0].opacity, 0.5);
    } finally { snapshot.release(); }
    assert.equal(appearanceAssets.get(reference.assetId), undefined);
  });

  it('maps all four raster landmarks through two SVG affine triangles', async () => {
    const reference = await record();
    useViewerStore.setState({ appearanceReferences: new Map([[reference.id,reference]]) });
    const snapshot = snapshotDrawingReferences(useViewerStore.getState(), { axis:'y',position:0,flipped:false });
    try {
      const map = (x:number,y:number) => ({x:10-2*x,y:20+2*y});
      const xml = new DOMParser().parseFromString(`<svg xmlns="http://www.w3.org/2000/svg">${buildRasterReferenceSvg(snapshot.references,map)}</svg>`, 'image/svg+xml');
      const images = [...xml.querySelectorAll('image')];
      assert.equal(images.length,2);
      const positions = [[0,0],[1,0],[1,1],[0,1]];
      for (let corner=0;corner<4;corner++) {
        const image = images[corner === 3 ? 1 : 0];
        const matrix = image.getAttribute('transform')!.slice(7,-1).split(' ').map(Number);
        const [x,y] = positions[corner], expected = map(snapshot.references[0].corners[corner].x,snapshot.references[0].corners[corner].y);
        assert.equal(matrix[0]*x+matrix[2]*y+matrix[4],expected.x);
        assert.equal(matrix[1]*x+matrix[3]*y+matrix[5],expected.y);
      }
      assert.equal(xml.querySelectorAll('clipPath polygon').length,2);
      assert.ok(images.every(image => image.getAttribute('href')?.startsWith('data:image/png;base64,')));
    } finally { snapshot.release(); }
  });

  it('filters hidden, transparent and edge-on references before export', async () => {
    const reference = await record();
    useViewerStore.setState({ appearanceReferences: new Map([
      ['hidden',{...reference,id:'hidden',visible:false}], ['transparent',{...reference,id:'transparent',opacity:0}],
      ['edge',{...reference,id:'edge',cornersIfcWorld:[[0,0,0],[0,0,2],[0,2,2],[0,2,0]]}],
    ]) });
    const snapshot = snapshotDrawingReferences(useViewerStore.getState(),{axis:'y',position:0,flipped:false});
    try { assert.equal(snapshot.references.length,0); } finally { snapshot.release(); }
  });

  it('emits mapped DXF landmarks once with the final coordinate transform', () => {
    const drawing = { lines:[],cutPolygons:[] } as unknown as Drawing2D;
    const dxf = parseDxf(exportToDXF(drawing, { underlays:mappedDxfUnderlayOptions(vectors),
      coordinateTransform:p=>({x:p.x+100,y:-p.y}) }));
    const path = dxf.entities.find(entity=>entity.kind==='polyline');
    assert.ok(path?.kind==='polyline');
    assert.deepEqual(path.vertices.map(({x,y})=>({x,y})),[{x:102,y:-3},{x:106,y:-7}]);
    assert.equal(dxf.entities.some(entity=>entity.kind==='text' && entity.text==='Elevation'),true);
    assert.equal(mappedDxfUnderlayOptions([{...vectors[0],opacity:0}]).length,0);
  });

  it('keeps vector DXF strokes and text as PDF paths/text rather than images', () => {
    const doc = new jsPDF({unit:'mm',format:[100,100]});
    drawDxfUnderlaysPdf(doc,vectors,(x,y)=>({x:x*10,y:y*10}),10);
    const pdf = doc.output();
    assert.match(pdf,/\(Elevation\)/);
    assert.match(pdf,/\/ExtGState/);
    assert.doesNotMatch(pdf,/\/Subtype \/Image/);
    assert.match(pdf,/\bm\n/); assert.match(pdf,/\bl\n/);
  });

  it('uses the canvas multiline spacing in the emitted vector PDF (#6615)', () => {
    const doc = new jsPDF({unit:'mm',format:[100,100]});
    const multiline = [{...vectors[0],texts:[{...vectors[0].texts[0],text:'Upper\nLower'}]}];
    drawDxfUnderlaysPdf(doc,multiline,(x,y)=>({x:x*10,y:y*10}),10);
    const pdf = doc.output();
    const leadings = [...pdf.matchAll(/([\d.]+) TL/g)].map(match=>Number(match[1]));
    const expected = vectors[0].texts[0].height * 10 * 72 / 25.4 * 1.3;
    assert.ok(leadings.some(value=>Math.abs(value-expected)<0.01),'PDF text advances by 1.3 times its physical font height');
    assert.match(pdf,/\(Upper\) Tj/); assert.match(pdf,/\(Lower\) Tj/); assert.match(pdf,/T\*/);
  });

  it('keeps multiline DXF spacing at 1.3 text heights after placement/georeference scale (#6615)', () => {
    const underlay = importDxf(['0','SECTION','2','HEADER','9','$INSUNITS','70','6','0','ENDSEC',
      '0','SECTION','2','ENTITIES','0','MTEXT','8','labels','10','2','20','3','40','0.2','1','Upper\\PLower',
      '0','ENDSEC','0','EOF'].join('\n'));
    const source: DxfUnderlayState = {id:'scaled-label',name:'scaled-label',underlay,visible:true,visible3D:true,
      opacity:1,layerVisibility:{},georeferenced:true,placement:{offsetX:0,offsetY:0,rotationDeg:30,scale:2}};
    const mapped = dxfUnderlayToDrawing(source,{x:0,y:0},false,p=>({x:p.x*3,y:p.y*3}),true);
    assert.equal(mapped.texts.length,1);
    assert.ok(Math.abs(mapped.texts[0].height-1.2)<1e-9);
    const drawing = {lines:[],cutPolygons:[]} as unknown as Drawing2D;
    for (const axis of ['front','side'] as const) {
      const exported = parseDxf(exportToDXF(drawing,{underlays:mappedDxfUnderlayOptions([mapped],axis)}));
      const texts = exported.entities.filter(entity=>entity.kind==='text');
      assert.equal(texts.length,2);
      assert.ok(texts[0].kind==='text' && texts[1].kind==='text');
      const delta = {x:texts[1].x-texts[0].x,y:texts[1].y-texts[0].y};
      assert.ok(Math.abs(Math.hypot(delta.x,delta.y)-1.56)<1e-5,'line gap is 1.3 times the mapped 1.2 metre height');
      const direction = mapped.texts[0];
      assert.ok(Math.abs(delta.x*direction.dirX+delta.y*direction.dirY)<1e-5,'lines advance perpendicular to the rotated baseline');
    }
  });

  it('stacks multiline DXF text along the same screen direction in Front and Side', () => {
    const drawing = { lines:[],cutPolygons:[] } as unknown as Drawing2D;
    const multiline = [{ ...vectors[0], texts:[{...vectors[0].texts[0],text:'Upper\nLower'}] }];
    for (const axis of ['front','side'] as const) {
      const dxf = parseDxf(exportToDXF(drawing,{underlays:mappedDxfUnderlayOptions(multiline,axis)}));
      const texts = dxf.entities.filter(entity=>entity.kind==='text');
      assert.equal(texts.length,2);
      assert.ok(texts[0].kind==='text' && texts[1].kind==='text');
      // Final Front Y flip makes negative drawing-Y positive screen-Y;
      // Side flips both axes, rotating the baseline and its perpendicular.
      assert.ok(Math.abs(texts[1].y-texts[0].y-(axis==='front'?-0.26:0.26))<1e-9);
    }
  });
});
