/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Renderer } from '@ifc-lite/renderer';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { clearGlobalRefs, setGlobalRendererRef } from '@/hooks/useBCF';
import { render, click, cleanup, advance } from '@/test/render';
import { readFileSync } from 'node:fs';
import { initSync } from '@ifc-lite/wasm';
import { IfcParser, EntityExtractor } from '@ifc-lite/parser';
import { ExportDialog } from '@/components/viewer/ExportDialog';
import { sectionExportOptions, useSectionExport } from './section-export';

beforeEach(() => {
  useViewerStore.getState().resetViewerState();
  useViewerStore.setState(fixtureModels(fixtureModel('m')));
  setGlobalRendererRef({current:{getCamera:()=>({getSceneBounds:()=>({min:{x:-5,y:-4,z:-3},max:{x:5,y:4,z:3}})})} as unknown as Renderer});
});
afterEach(() => { cleanup(); clearGlobalRefs(); useViewerStore.getState().resetViewerState(); });

function enablePlane(normal: [number,number,number], distance: number) {
  const state = useViewerStore.getState();
  useViewerStore.setState({sectionPlane:{...state.sectionPlane, enabled:true, flipped:false, custom:{normal,distance,pickedAt:[0,0,0],tangent:[0,1,0],bitangent:[0,0,1]}}});
}

test('#7711 exported planes keep the same side as the screen, including a six-face box and inactive planes', () => {
  enablePlane([1,0,0], 2);
  let options = sectionExportOptions(useViewerStore.getState(), 'trim', 'm')!;
  assert.deepEqual(options.planes, [{normal:[1,0,0],offset:2}]);
  const state = useViewerStore.getState();
  useViewerStore.setState({inactiveSectionPlanes:[{...state.sectionPlane,id:'extra',custom:{normal:[0,1,0],distance:1,pickedAt:[0,0,0],tangent:[1,0,0],bitangent:[0,0,1]}}]});
  options = sectionExportOptions(useViewerStore.getState(), 'trim', 'm')!;
  assert.deepEqual(options.planes[1], {normal:[0,0,1],offset:1});
  useViewerStore.setState({sectionPlane:{...state.sectionPlane,flipped:true}});
  const flipped = sectionExportOptions(useViewerStore.getState(), 'trim', 'm')!.planes[0];
  assert.deepEqual(flipped.normal.map(value => value+0), [-1,0,0]);
  assert.equal(flipped.offset,-2);
  useViewerStore.setState({sectionPlane:{...state.sectionPlane,box:{min:[-1,-2,-3],max:[1,2,3]}}});
  assert.equal(sectionExportOptions(useViewerStore.getState(), 'trim', 'm')?.planes.length, 7);
});

test('#7711 one shared federation frame maps the crop into each source model despite offsets and workspace moves', () => {
  enablePlane([1,0,0], 2);
  const state = useViewerStore.getState();
  const bounds = {min:{x:-5,y:-4,z:-3},max:{x:5,y:4,z:3}};
  const info = { originShift:{x:10,y:0,z:0}, wasmRtcOffset:{x:5_000_000,y:0,z:0}, originalBounds:bounds, shiftedBounds:bounds, hasLargeCoordinates:true };
  const model = fixtureModel('m');
  const geometry = {meshes:[],totalVertices:0,totalTriangles:0,coordinateInfo:info};
  useViewerStore.setState({ models:new Map([['m',{...model,loadedAt:1,geometryResult:geometry}],
    ['n',{...fixtureModel('n',{idOffset:1_000_000}),loadedAt:2,geometryResult:geometry}]]),
    modelPlacement:{...state.modelPlacement,placements:new Map([['n',{translation:[5,0,0],rotation:{angle:0,pivot:[0,0,0]},locked:false}]])} });
  const primary = sectionExportOptions(useViewerStore.getState(), 'trim', 'm')!;
  const peer = sectionExportOptions(useViewerStore.getState(), 'trim', 'n')!;
  assert.equal(primary.planes[0].offset, 5_000_012);
  assert.equal(peer.planes[0].offset, 5_000_007);
  useViewerStore.setState({modelPlacement:{...state.modelPlacement,placements:new Map([
    ['n',{translation:[5,0,0],rotation:{angle:Math.PI/2,pivot:[2,3,0]},locked:false}],
  ])}});
  const rotated = sectionExportOptions(useViewerStore.getState(), 'trim', 'n')!.planes[0];
  assert.ok(Math.abs(rotated.normal[0])<1e-12);
  assert.equal(rotated.normal[1],-1);
  assert.ok(Math.abs(rotated.offset+8)<1e-8,'a heading about a nonzero pivot is undone before restoring world coordinates');
});

test('#7711 the mounted trim control changes the actual export option to whole and is absent for unsupported export modes', () => {
  enablePlane([1,0,0], 0);
  let read = () => undefined as ReturnType<ReturnType<typeof useSectionExport>['options']>;
  function Options({enabled=true}:{enabled?:boolean}) {
    const section = useSectionExport(enabled); read = section.options;
    return section.control;
  }
  const ui = render(<Options />);
  assert.equal(read()?.mode, 'trim');
  click(ui.querySelector('button[role="switch"]')!);
  assert.equal(read()?.mode, 'whole');
  cleanup();
  const disabled = render(<Options enabled={false} />);
  assert.equal(disabled.querySelector('[role="switch"]'), null);
  assert.equal(read(), undefined);
});


test('#7711 the actual IFC dialog downloads clipped geometry and honors the whole-element switch', async () => {
  initSync({module:new Uint8Array(readFileSync(new URL('../../../../../packages/wasm/pkg/ifc-lite_bg.wasm', import.meta.url)))});
  const bytes = new TextEncoder().encode(`ISO-10303-21;
HEADER;
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0M7tQ9Jbj1BAeHd7rqnDmQ',$,'Project',$,$,$,$,(#10),#4);
#2=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#4=IFCUNITASSIGNMENT((#2));
#10=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#11,$);
#11=IFCAXIS2PLACEMENT3D(#12,$,$);
#12=IFCCARTESIANPOINT((0.,0.,0.));
#22=IFCLOCALPLACEMENT($,#11);
#41=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,10.,8.);
#42=IFCEXTRUDEDAREASOLID(#41,#11,#43,2.);
#43=IFCDIRECTION((0.,0.,1.));
#44=IFCSHAPEREPRESENTATION(#10,'Body','SweptSolid',(#42));
#45=IFCPRODUCTDEFINITIONSHAPE($,$,(#44));
#50=IFCSLAB('0M7tQ9Jbj1BAeHd7rqnDmR',$,'Slab',$,$,#22,#45,$,.FLOOR.);
ENDSEC;
END-ISO-10303-21;`);
  const store = await new IfcParser().parseColumnar(bytes.buffer, {disableWorkerScan:true});
  const model = {...fixtureModel('m'),ifcDataStore:store,schemaVersion:'IFC4' as const,maxExpressId:50};
  useViewerStore.setState(fixtureModels(model));
  enablePlane([1,0,0],0);
  const originalCreate = URL.createObjectURL, originalRevoke = URL.revokeObjectURL;
  const originalClick = HTMLAnchorElement.prototype.click;
  const downloads: Blob[] = [];
  URL.createObjectURL = ((blob: Blob) => {downloads.push(blob); return 'blob:section-export-test';}) as typeof URL.createObjectURL;
  URL.revokeObjectURL = () => {};
  HTMLAnchorElement.prototype.click = function () {};
  const button = (label: string) => {
    const found = [...document.querySelectorAll('button')].find(el => el.textContent?.trim()===label);
    assert.ok(found, `dialog action ${label} is mounted`); return found;
  };
  try {
    for (const trim of [true,false]) {
      render(<ExportDialog surface="ribbon" />);
      click(button('Export IFC'));
      const visible = [...document.querySelectorAll('label')].find(el => el.textContent==='Export Visible Only');
      const visibleToggle = visible?.parentElement?.parentElement?.querySelector('[role="switch"]');
      assert.ok(visibleToggle); click(visibleToggle);
      const control = document.getElementById('trim-section-export');
      assert.ok(control, 'the real export dialog exposes the section control');
      if (!trim) click(control);
      const previous = downloads.length;
      click(button('Export'));
      for (let i=0;i<100 && downloads.length===previous;i++) await advance(20);
      assert.equal(downloads.length, previous+1, document.body.textContent ?? 'export did not download');
      const reopened = await new IfcParser().parseColumnar(await downloads.at(-1)!.arrayBuffer(), {disableWorkerScan:true});
      assert.equal(reopened.entities.getGlobalId(50), store.entities.getGlobalId(50));
      if (trim) {
        const list = reopened.entityIndex.byType.get('IFCCARTESIANPOINTLIST3D');
        assert.equal(list?.length,1,'the downloaded product uses the replacement tessellation');
        const coordinates = new EntityExtractor(reopened.source!).extractEntity(reopened.entityIndex.byId.get(list![0])!)?.attributes[0];
        assert.ok(Array.isArray(coordinates));
        assert.ok(coordinates.every(p => Array.isArray(p) && typeof p[0]==='number' && p[0]<=1e-7));
      } else {
        assert.equal(reopened.entityIndex.byType.get('IFCTRIANGULATEDFACESET')?.length ?? 0,0);
        assert.ok(reopened.entityIndex.byId.has(42),'whole mode retains the authored solid');
      }
      cleanup();
    }
  } finally {
    URL.createObjectURL=originalCreate; URL.revokeObjectURL=originalRevoke;
    HTMLAnchorElement.prototype.click=originalClick;
  }
});
