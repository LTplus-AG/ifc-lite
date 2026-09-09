/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { installLayout } from '@/test/dom-layout.js';
import { test, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { act, useRef } from 'react';
import { GraphicOverrideEngine, PAPER_SIZE_REGISTRY, FRAME_PRESETS, TITLE_BLOCK_PRESETS,
  DEFAULT_TITLE_BLOCK_FIELDS, DEFAULT_SCALE_BAR, DEFAULT_NORTH_ARROW, type DrawingSheet, type Drawing2D } from '@ifc-lite/drawing-2d';
import { render, cleanup, click } from '@/test/render';
import { useDrawingWithReferences } from '@/hooks/useReferenceImagesForDrawing';
import { useViewControls } from '@/hooks/useViewControls';
import type { CachedSheetTransform } from '@/lib/drawing/sheet-geometry-key';
import { useViewerStore } from '@/store';
import { appearanceAssets } from '@/lib/appearance/model-assets';
import { emptyPlacementState } from '@/lib/model-placement/state';
import type { RegisteredAppearanceReference } from '@/lib/appearance/references/types';
import { Drawing2DCanvas } from './Drawing2DCanvas';
installLayout();
const png = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==','base64'));
const owner = { kind: 'source' as const, id: 'drawing-reference-fixture' };
type Matrix = [number, number, number, number, number, number];
type Point = [number, number];
function recordCanvas() {
  let matrix: Matrix = [1,0,0,1,0,0]; const stack: Matrix[] = [], images: Point[][] = [];
  function transform(a:number,b:number,c:number,d:number,e:number,f:number) {
    const [A,B,C,D,E,F]=matrix;
    matrix=[A*a+C*b,B*a+D*b,A*c+C*d,B*c+D*d,A*e+C*f+E,B*e+D*f+F];
  }
  const ctx = new Proxy({}, { get(_target,key) {
    if (key === 'canvas') return {width:800,height:600};
    if (key === 'save') return () => stack.push([...matrix]);
    if (key === 'restore') return () => { matrix=stack.pop()!; };
    if (key === 'setTransform') return (...values:Matrix) => {matrix=values;};
    if (key === 'scale') return (x:number,y:number) => transform(x,0,0,y,0,0);
    if (key === 'translate') return (x:number,y:number) => transform(1,0,0,1,x,y);
    if (key === 'transform') return transform;
    if (key === 'measureText') return () => ({width:0});
    if (key === 'drawImage') return (image:ImageBitmap) => {
      const [a,b,c,d,e,f]=matrix;
      images.push([[0,0],[image.width,0],[image.width,image.height],[0,image.height]].map(([x,y])=>[a*x+c*y+e,b*x+d*y+f]));
    };
    return () => undefined;
  }, set(){return true;} }) as CanvasRenderingContext2D;
  mock.method(HTMLCanvasElement.prototype,'getContext',()=>ctx);
  return images;
}
async function settle() { await act(async()=>{await new Promise(resolve=>setTimeout(resolve,20));}); }
function drawing(axis:'x'|'y'|'z',flipped=false): Drawing2D {
  return {config:{plane:{axis,position:0,flipped},projectionDepth:10,includeHiddenLines:false,creaseAngle:30,scale:100},
    lines:[],cutPolygons:[],projectionPolygons:[],bounds:{min:{x:0,y:0},max:{x:10,y:10}},
    stats:{cutLineCount:0,projectionLineCount:0,hiddenLineCount:0,silhouetteLineCount:0,polygonCount:0,totalTriangles:0,processingTimeMs:0}};
}
async function fixture(corners:RegisteredAppearanceReference['cornersIfcWorld'],rtc=false) {
  const asset=await appearanceAssets.add(png,{owner});
  mock.method(appearanceAssets,'decode',async()=>({width:2,height:3,close(){}}));
  const record:RegisteredAppearanceReference={id:'reference',sourceId:'page',assetId:asset.id,visible:true,locked:false,opacity:1,
    frameKey:'local-engineering:m:z-up',cornersIfcWorld:corners};
  const bounds={min:{x:0,y:0,z:0},max:{x:10,y:10,z:10}};
  useViewerStore.setState({models:new Map(),modelPlacement:emptyPlacementState(),appearanceReferences:new Map([[record.id,record]]),referenceUndo:[],referenceRedo:[],
    geometryResult:rtc ? {meshes:[],totalTriangles:0,totalVertices:0,coordinateInfo:{originShift:{x:0,y:0,z:0},wasmRtcOffset:{x:5000000,y:1000000,z:100},originalBounds:bounds,shiftedBounds:bounds,hasLargeCoordinates:true}}:null});
  return record;
}
afterEach(()=>{cleanup();useViewerStore.setState({appearanceReferences:new Map()});appearanceAssets.releaseOwner(owner);mock.restoreAll();});

const cases = [
  {axis:'y' as const,section:'down' as const,corners:[[2,5,3],[4,5,3],[4,2,3],[2,2,3]] as const,expected:[[120,150],[140,150],[140,180],[120,180]]},
  {axis:'z' as const,section:'front' as const,corners:[[2,5,6],[4,5,6],[4,5,3],[2,5,3]] as const,expected:[[120,140],[140,140],[140,170],[120,170]]},
  {axis:'x' as const,section:'side' as const,corners:[[2,5,6],[2,2,6],[2,2,3],[2,5,3]] as const,expected:[[150,140],[120,140],[120,170],[150,170]]},
];
for (const entry of cases) for (const flipped of [false,true]) test(`registered PDF/image corners reach the actual ${entry.section} canvas, flipped=${flipped}, after RTC (#4308)`,async()=>{
  const images=recordCanvas();
  const shifted=entry.corners.map(p=>[p[0]+5000000,p[1]+1000000,p[2]+100]) as unknown as RegisteredAppearanceReference['cornersIfcWorld'];
  await fixture(shifted,true);
  render(<Drawing2DCanvas drawing={drawing(entry.axis,flipped)} sectionAxis={entry.section} transform={{x:100,y:200,scale:10}}
    showHiddenLines={false} overrideEngine={new GraphicOverrideEngine()} overridesEnabled={false} entityColorMap={new Map()} useIfcMaterials={false}/>);
  await settle();
  assert.ok(images.length>=2,'the mounted canvas actually paints both image triangles');
  assert.deepEqual(images.at(-1),entry.expected.map(([x,y])=>[flipped?200-x:x,y]));
});

test('hide, incompatible frame and removal erase a decoded drawing reference; locking preserves its image (#4308)',async()=>{
  const images=recordCanvas(),record=await fixture(cases[0].corners);
  render(<Drawing2DCanvas drawing={drawing('y')} sectionAxis="down" transform={{x:100,y:200,scale:10}}
    showHiddenLines={false} overrideEngine={new GraphicOverrideEngine()} overridesEnabled={false} entityColorMap={new Map()} useIfcMaterials={false}/>);
  await settle();assert.ok(images.length>0);
  for(const update of [{locked:true},{visible:false},{visible:true,frameKey:'foreign-frame'}]) {
    images.length=0;act(()=>useViewerStore.setState({appearanceReferences:new Map([[record.id,{...record,...update}]])}));await settle();
    assert.equal(images.length>0,'locked' in update);
  }
  images.length=0;act(()=>useViewerStore.setState({appearanceReferences:new Map()}));await settle();assert.equal(images.length,0);
});

test('a decoder completing after the canvas closes cannot retain an image lease or publish (#4308)',async()=>{
  const images=recordCanvas(),record=await fixture(cases[0].corners);
  let finish:(image:ImageBitmap)=>void=()=>{};
  mock.method(appearanceAssets,'decode',()=>new Promise<ImageBitmap>(resolve=>{finish=resolve;}));
  render(<Drawing2DCanvas drawing={drawing('y')} sectionAxis="down" transform={{x:0,y:0,scale:1}}
    showHiddenLines={false} overrideEngine={new GraphicOverrideEngine()} overridesEnabled={false} entityColorMap={new Map()} useIfcMaterials={false}/>);
  await settle();cleanup();await act(async()=>{finish({width:2,height:3,close(){}} as ImageBitmap);});
  assert.equal(images.length,0);useViewerStore.setState({appearanceReferences:new Map()});
  appearanceAssets.releaseOwner(owner);assert.equal(appearanceAssets.get(record.assetId),undefined);
});

test('registered raster uses the sheet viewport transform without a second image-axis flip (#4308)',async()=>{
  const images=recordCanvas();await fixture(cases[0].corners);
  const data=drawing('y');data.bounds={min:{x:0,y:-10},max:{x:10,y:0}};
  const sheet:DrawingSheet={id:'sheet',name:'sheet',paper:PAPER_SIZE_REGISTRY.A3_LANDSCAPE,
    frame:{style:'professional',...FRAME_PRESETS.professional},titleBlock:{...TITLE_BLOCK_PRESETS.standard,
      fields:DEFAULT_TITLE_BLOCK_FIELDS.map(f=>({...f})),logo:null},scaleBar:{...DEFAULT_SCALE_BAR},
    scale:{name:'1:100',factor:100,useCase:''},northArrow:{...DEFAULT_NORTH_ARROW},viewportBounds:{x:10,y:10,width:200,height:100},revisions:[]};
  render(<Drawing2DCanvas drawing={data} sectionAxis="down" transform={{x:0,y:0,scale:1}} sheetEnabled activeSheet={sheet}
    showHiddenLines={false} overrideEngine={new GraphicOverrideEngine()} overridesEnabled={false} entityColorMap={new Map()} useIfcMaterials={false}/>);
  await settle();assert.deepEqual(images.at(-1),[[81.5,60],[100.5,60],[100.5,88.5],[81.5,88.5]]);
});

test('custom section uses its explicit basis and origin, not cardinal flipped projection (#4308)',async()=>{
  const images=recordCanvas();await fixture([[12,-25,3],[12,-27,3],[15,-27,3],[15,-25,3]]);
  const data=drawing('y',true);data.config.plane.customPlane={normal:{x:0,y:1,z:0},distance:3,
    origin:{x:10,y:3,z:20},tangent:{x:0,y:0,z:1},bitangent:{x:1,y:0,z:0}};
  render(<Drawing2DCanvas drawing={data} sectionAxis="down" transform={{x:100,y:200,scale:10}}
    showHiddenLines={false} overrideEngine={new GraphicOverrideEngine()} overridesEnabled={false} entityColorMap={new Map()} useIfcMaterials={false}/>);
  await settle();assert.deepEqual(images.at(-1),[[150,220],[170,220],[170,250],[150,250]]);
});

test('relinking a missing original image repaints the existing reference without replacing its registration (#4308)',async()=>{
  const images=recordCanvas(),record=await fixture(cases[0].corners);
  useViewerStore.setState({appearanceReferences:new Map()});appearanceAssets.releaseOwner(owner);
  assert.equal(appearanceAssets.get(record.assetId),undefined);
  useViewerStore.setState({appearanceReferences:new Map([[record.id,record]])});
  render(<Drawing2DCanvas drawing={drawing('y')} sectionAxis="down" transform={{x:100,y:200,scale:10}}
    showHiddenLines={false} overrideEngine={new GraphicOverrideEngine()} overridesEnabled={false} entityColorMap={new Map()} useIfcMaterials={false}/>);
  await settle();assert.equal(images.length,0);
  await act(async()=>{await useViewerStore.getState().relinkAppearanceReference(record.id,new File([png],'original.png',{type:'image/png'}));});await settle();
  assert.deepEqual(images.at(-1),cases[0].expected);
  assert.equal(useViewerStore.getState().appearanceReferences.get(record.id),record);
});

test('Fit includes a registered raster on an otherwise empty section without altering source bounds (#4308)',async()=>{
  const images=recordCanvas();await fixture(cases[0].corners);
  const source=drawing('y');source.bounds={min:{x:5000000,y:5000000},max:{x:5000001,y:5000001}};
  function FitCanvas() {
    const {drawing:data}=useDrawingWithReferences(source),containerRef=useRef<HTMLDivElement>(null);
    const cachedSheetTransformRef=useRef<CachedSheetTransform|null>(null);
    const controls=useViewControls({drawing:data,sectionPlane:{axis:'down',position:0,flipped:false},containerRef,
      panelVisible:true,status:'ready',sheetEnabled:false,activeSheet:null,isPinned:true,cachedSheetTransformRef});
    return <div ref={containerRef}><button onClick={controls.fitToView}>Fit</button><Drawing2DCanvas drawing={data!} sectionAxis="down"
      transform={controls.viewTransform} showHiddenLines={false} overrideEngine={new GraphicOverrideEngine()}
      overridesEnabled={false} entityColorMap={new Map()} useIfcMaterials={false}/></div>;
  }
  const ui=render(<FitCanvas/>);await settle();click(ui.querySelector('button')!);await settle();
  const points=images.at(-1)!;assert.ok(points);
  assert.ok(Math.abs((points[0][0]+points[2][0])/2-640)<1e-8);
  assert.ok(Math.abs((points[0][1]+points[2][1])/2-400)<1e-8);
  assert.ok(points.every(([x,y])=>x>=192 && x<=1088 && y>=119.999999 && y<=680.000001));
  assert.ok(Math.abs(points[2][1]-points[0][1]-560)<1e-8,'reference fills available height with 15% margins');
  assert.deepEqual(source.bounds,{min:{x:5000000,y:5000000},max:{x:5000001,y:5000001}});
});
