/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hardwareAdapter, loadTarget, ownOpenings, themedResult } from '../../tests/modelling-parity/ui/lib/oracles.mjs';
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
