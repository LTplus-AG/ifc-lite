/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { wallEndpointsJoined, copiedPlansMatch, hasDwgDownload, assignedTypes, uniqueWallJoins, hardwareAdapter, loadTarget, ownOpenings, themedResult, wallPropertySets, wallQuantityCoverage, uncontainedInStoreys } from '../../tests/modelling-parity/ui/lib/oracles.mjs';
import { readStep } from '../../tests/modelling-parity/ui/lib/step.mjs';
test('#9324 fallback flags and software adapter descriptions are refused',()=>{
  assert.equal(hardwareAdapter({architecture:'blackwell'}),true);
  for(const a of [{isFallbackAdapter:true},{info:{isFallbackAdapter:true}},...['SwiftShader','llvmpipe','lavapipe','Microsoft Basic Render Driver'].flatMap(s=>[{architecture:s},{description:s}])]) assert.equal(hardwareAdapter(a),false);
});
test('#9324 only absent targets fall back; broken or unreadable files throw',()=>{
  const dir=mkdtempSync(join(tmpdir(),'ui-target-'));
  try {
    const file=join(dir,'target.json');
    assert.match(loadTarget(file,{}).from,/embedded/);
    writeFileSync(file,'{'); assert.throws(()=>loadTarget(file,{}),SyntaxError);
    writeFileSync(file,'{}'); assert.throws(()=>loadTarget(file,{}),/Malformed/);
    assert.throws(()=>loadTarget(dir,{}));
    const target={storeys:[],spaces:[],roof:{},footprint:{},totals:{},tolerances:{}};
    writeFileSync(file,JSON.stringify(target)); assert.match(loadTarget(file,{}).from,/references/);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
test('#9324 a dark-only failure remains a separately failed result',()=>{
  const results=[themedResult({id:'F1.ui',status:'pass'},'light'),themedResult({id:'F1.ui',status:'fail'},'dark')];
  assert.equal(results.find(r=>r.id==='F1.ui.dark').status,'fail');
});
test('#9324 door and window need distinct IfcOpeningElements',()=>{
  const base="#1=IFCDOOR('d');#2=IFCWINDOW('w');#3=IFCOPENINGELEMENT('o');#4=IFCOPENINGELEMENT('p');#5=IFCRELFILLSELEMENT('r',$,$,$,#3,#1);";
  const check=(id)=>ownOpenings(readStep("DATA;"+base+`#6=IFCRELFILLSELEMENT('s',$,$,$,#${id},#2);ENDSEC;`),[{id:1},{id:2}]);
  assert.equal(check(3),false); assert.equal(check(4),true); assert.equal(check(1),false);
});

test('#9324 unrelated property sets cannot certify wall assignments', () => {
  const base = "#1=IFCWALL('w',$,$,$,$,$,$,$,$);#2=IFCPROPERTYSET('p',$,'Pset_WallCommon',$,());";
  const read = (rel) => readStep('DATA;' + base + rel + 'ENDSEC;');
  assert.deepEqual(wallPropertySets(read("#3=IFCRELDEFINESBYPROPERTIES('r',$,$,$,(#99),#2);")), [[]]);
  assert.deepEqual(wallPropertySets(read("#3=IFCRELDEFINESBYPROPERTIES('r',$,$,$,(#1),#2);")), [['Pset_WallCommon']]);
});

test('#9324 base quantities on one wall cannot certify all walls', () => {
  const step = readStep("DATA;#1=IFCWALL('a');#2=IFCWALL('b');#3=IFCQUANTITYLENGTH('Length',$,$,5.,$);#4=IFCQUANTITYVOLUME('NetVolume',$,$,3.,$);#5=IFCELEMENTQUANTITY('q',$,$,$,$,(#3,#4));#6=IFCRELDEFINESBYPROPERTIES('r',$,$,$,(#1),#5);ENDSEC;");
  assert.deepEqual(wallQuantityCoverage(step), [{Length: 5, NetVolume: 3}, {}]);
});

test('#9324 duplicate wall connections and unassigned types cannot certify behaviour', () => {
  const base = "#1=IFCWALL('a');#2=IFCWALL('b');#3=IFCDOOR('d');#4=IFCDOORTYPE('t');";
  const step = readStep("DATA;" + base + "#5=IFCRELCONNECTSPATHELEMENTS('a',$,$,$,$,#1,#2,(),(),.ATSTART.,.ATEND.);#6=IFCRELCONNECTSPATHELEMENTS('b',$,$,$,$,#1,#2,(),(),.ATSTART.,.ATEND.);ENDSEC;");
  assert.equal(uniqueWallJoins(step), 1);
  assert.equal(assignedTypes(step, step.of('IFCDOOR')), false);
  const linked = readStep('DATA;' + base + "#7=IFCRELDEFINESBYTYPE('r',$,$,$,(#3),#4);ENDSEC;");
  assert.equal(assignedTypes(linked, linked.of('IFCDOOR')), true);
});

test('#9324 PDF and DXF exports cannot stand in for the required DWG output', () => {
  assert.equal(hasDwgDownload(undefined), false);
  assert.equal(hasDwgDownload({bytes: Buffer.from('%PDF-1.7')}), false);
  assert.equal(hasDwgDownload({bytes: Buffer.from('AC1032payload')}), true);
});

test('#9324 every target floor retains copied plan positions and wall multiplicity', () => {
  const wall = (x) => ({start:[x,0],end:[x,1]});
  const source = [wall(0),wall(2)];
  assert.equal(copiedPlansMatch(source,[source,source]),true);
  assert.equal(copiedPlansMatch(source,[source,[wall(1),wall(3)]]),false);
  assert.equal(copiedPlansMatch(source,[[wall(0),wall(0)],source]),false);
});
test('#9324 joins between the same walls retain distinct endpoints', () => {
  const step = readStep("DATA;#1=IFCWALL('a');#2=IFCWALL('b');#5=IFCRELCONNECTSPATHELEMENTS('a',$,$,$,$,#1,#2,(),(),.ATSTART.,.ATEND.);#6=IFCRELCONNECTSPATHELEMENTS('b',$,$,$,$,#1,#2,(),(),.ATEND.,.ATSTART.);ENDSEC;");
  assert.equal(uniqueWallJoins(step),2);
});

test('#9324 malformed products cannot contribute counts or relationships', () => {
  assert.throws(() => readStep("DATA;#42=IFCDOOR(BROKEN);#43=IFCRELFILLSELEMENT('r',$,$,$,#1,#42);ENDSEC;"), /STEP parse error/);
});

test('#9324 repeated pairs cannot stand in for all four joined corners', () => {
  const walls = "#1=IFCWALL('a');#2=IFCWALL('b');#3=IFCWALL('c');#4=IFCWALL('d');";
  const link = (id,a,b,start,end) => `#${id}=IFCRELCONNECTSPATHELEMENTS('r',$,$,$,$,#${a},#${b},(),(),.${end}.,.${start}.);`;
  const repeated = readStep('DATA;'+walls+link(5,1,2,'ATSTART','ATSTART')+link(6,1,2,'ATSTART','ATEND')+link(7,1,2,'ATEND','ATSTART')+link(8,1,2,'ATEND','ATEND')+'ENDSEC;');
  assert.equal(uniqueWallJoins(repeated),4);
  assert.equal(wallEndpointsJoined(repeated),false);
  const ring = readStep('DATA;'+walls+[1,2,3,4].map((id,i)=>link(5+i,id,id%4+1,'ATEND','ATSTART')).join('')+'ENDSEC;');
  assert.equal(wallEndpointsJoined(ring),true);
});

test('#9324 containment in a building, not a storey, counts as uncontained',()=>{
  const head="DATA;#1=IFCBUILDING('b',$,'B',$,$,$,$,$,$,$,$,$);#2=IFCBUILDINGSTOREY('s',$,'L0',$,$,$,$,$,$,0.);#3=IFCWALL('w',$,'W',$,$,$,$,$,$);";
  const inBuilding=readStep(head+"#4=IFCRELCONTAINEDINSPATIALSTRUCTURE('r',$,$,$,(#3),#1);ENDSEC;");
  assert.equal(uncontainedInStoreys(inBuilding,inBuilding.of('IFCWALL')),1);
  const inStorey=readStep(head+"#4=IFCRELCONTAINEDINSPATIALSTRUCTURE('r',$,$,$,(#3),#2);ENDSEC;");
  assert.equal(uncontainedInStoreys(inStorey,inStorey.of('IFCWALL')),0);
});

// #9296 U1: the UI roof verdict must inspect the exported roof's geometry.
test('#9296 roof geometry accepts a real pitched plate, rejects labels, slabs and unrelated meshes', async () => {
  const { roofGeometry } = await import('../../tests/modelling-parity/ui/lib/oracles.mjs');
  assert.equal(typeof roofGeometry, 'function');
  const footprint = [[0,0],[10,0],[10,8],[0,8]], tilt = 10 * Math.PI / 180;
  const expected = {footprint, slopes: [tilt,0,0,0], thickness: .25};
  const shape = (height) => {
    const pts = new Float64Array(24);
    for (let i = 0; i < 8; i++) {
      const x = i & 1, y = (i >> 1) & 1, z = (i >> 2) & 1;
      pts.set([10*x,8*y,height(y,z)],i*3);
    }
    const quads = [[0,2,3,1],[4,5,7,6],[0,1,5,4],[2,6,7,3],[0,4,6,2],[1,3,7,5]];
    return [{pts,idx:Uint32Array.from(quads.flatMap(([a,b,c,d])=>[a,b,c,a,c,d]))}];
  };
  const roof = readStep("DATA;#1=IFCROOF('r',$,$,$,$,$,$,$,.HIP_ROOF.);ENDSEC;");
  const plate = shape((y,z)=>8*y*Math.tan(tilt)+z*.25/Math.cos(tilt));
  assert.equal(roofGeometry(roof,new Map([[1,{parts:plate}]]),expected),true);
  for (const parts of [shape((_y,z)=>z*.25),shape((_y,z)=>z*(.25+8*Math.tan(tilt)))]) {
    assert.notEqual(roofGeometry(roof,new Map([[1,{parts}]]),expected),true,'a roof label cannot certify a slab or full-height prism');
  }
  assert.notEqual(roofGeometry(roof,new Map([[2,{parts:plate}]]),expected),true,'another element cannot supply the roof mesh');
  assert.notEqual(roofGeometry(readStep("DATA;#2=IFCWALL('w');ENDSEC;"),new Map([[2,{parts:plate}]]),expected),true);
});
