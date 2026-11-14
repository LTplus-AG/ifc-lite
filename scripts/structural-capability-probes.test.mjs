/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCorpus } from '../tests/structural-coverage/lib/corpus.mjs';
import { readStep } from '../tests/structural-coverage/lib/step.mjs';
import { loadPackages } from '../tests/structural-coverage/lib/packages.mjs';
import { compareDerived, measureDerivation, FRAME, mergeSupportOnlyNodes, isRestraintValue } from '../tests/structural-coverage/probes/capability-derive-toggle.mjs';

test('#9668: perturbing real derived axes, endpoints, links or connections cannot pass', async (t) => {
  const root = new URL('../', import.meta.url).pathname;
  const corpus = loadCorpus(root, { offline:true });
  const file = corpus.files.find((f)=>f.path===FRAME);
  if (!file) { t.skip('run pnpm fixtures to fetch the AxisVM roof truss'); return; }
  const ctx = {root,pkgs:await loadPackages(root)};
  const {actual,expected} = await measureDerivation(ctx,file);
  assert.ok(actual.members.length && actual.nodes.length);
  assert.ok(actual.members.every((m)=>m.links.length));
  const control = compareDerived(actual,expected);
  assert.equal(control.status,'partial');
  assert.equal(control.counts.matchedMembers,13);
  // #9923: mutate the real planner output before real apply/export, as a product regression would.
  const shiftedContext = { ...ctx, pkgs: { ...ctx.pkgs, create: { ...ctx.pkgs.create,
    planStructuralDerivation(...args) {
      const plan = ctx.pkgs.create.planStructuralDerivation(...args);
      const points = new Set([...plan.curveMembers.flatMap((m)=>[m.start,m.end]), ...plan.nodes.map((n)=>n.position)]);
      for (const point of points) point[0] += 0.01;
      return plan;
    },
  } } };
  const shifted = await measureDerivation(shiftedContext,file);
  const rejected = compareDerived(shifted.actual,expected);
  assert.equal(rejected.status,'fail','a 10 mm shift of every planned member earns no capability credit');
  assert.equal(rejected.counts.matchedMembers,0);
  assert.equal(rejected.counts.derivedMembers,13);
  const moved = structuredClone(actual);
  moved.members[0].ends[0][0] += 1;
  assert.ok(compareDerived(moved,expected).mismatches.length > control.mismatches.length);
  // Also isolate each comparison dimension against the unperturbed real output.
  assert.equal(compareDerived(actual,structuredClone(actual)).status,'pass');
  for (const mutate of [
    (a)=>{a.members[0].ends[0][0]+=1;},
    (a)=>{a.members[0].links=[];},
    (a)=>{a.nodes[0].position[2]+=1;},
    (a)=>{a.members.pop();},
    (a)=>{a.nodes.push({...structuredClone(a.nodes[0]),position:[10000,10000,10000]});},
  ]) {
    const changed = structuredClone(actual);
    mutate(changed);
    const result = compareDerived(changed,actual);
    assert.notEqual(result.status,'pass');
    assert.ok(result.mismatches.length);
  }
});


test('#9668: coincident support-only reference points merge into their joint', () => {
  const joint = { id:204, position:[0,0,0], links:[10], support:false, memberConnected:true };
  const support = { id:481, position:[0.0002,0,0], links:[], support:true, memberConnected:false };
  const member = { id:7, ends:[[0,0,0],[1,0,0]], links:[10] };
  const actual = { members:[member], nodes:[{id:900,position:[0,0,0],links:[10],support:true}] };
  const expected = { members:[member], nodes:mergeSupportOnlyNodes([joint,support]) };
  const result = compareDerived(actual,expected);
  assert.equal(result.status,'pass');
  assert.equal(result.counts.referenceNodes,1);
  assert.equal(result.counts.supportReferenceNodes,1);
  assert.equal(result.mismatches.length,0);
});

test('#9668: an unconnected derived support beside a joint remains an extra connection', () => {
  const member = { id:7, ends:[[0,0,0],[1,0,0]], links:[10] };
  const referenceJoint = { id:204, position:[0,0,0], links:[10], support:true, memberConnected:true };
  const derived = { members:[member], nodes:[
    {id:900,position:[0,0,0],links:[10],support:false,memberConnected:true},
    {id:901,position:[0,0,0],links:[],support:true,memberConnected:false},
  ] };
  const result = compareDerived(derived,{members:[member],nodes:[referenceJoint]});
  assert.notEqual(result.status,'pass');
  assert.ok(result.mismatches.some((problem)=>problem.includes('extra derived connection #901')));
});

test('#9668: coincident orphan reference points stay separate', () => {
  const member = { id:7, ends:[[0,0,0],[1,0,0]], links:[] };
  const orphans = [
    {id:20,position:[0,0,0],links:[],support:true,memberConnected:false},
    {id:21,position:[0,0,0],links:[],support:false,memberConnected:false},
  ];
  assert.equal(mergeSupportOnlyNodes(orphans).length,2);
  // A node tied only to a physical product, not to a member, is not a joint to merge into.
  const linkedOnly = [
    {id:30,position:[0,0,0],links:[10],support:false,memberConnected:false},
    {id:31,position:[0,0,0],links:[],support:true,memberConnected:false},
  ];
  assert.equal(mergeSupportOnlyNodes(linkedOnly).length,2);
  const result = compareDerived({members:[member],nodes:[orphans[0]]},{members:[member],nodes:orphans});
  assert.notEqual(result.status,'pass');
  assert.ok(result.mismatches.some((problem)=>problem.includes('reference connection #21')));
});

test('#9668: IFC4 typed restraint values count as supports', () => {
  // The shape readStep really produces for IFC4 boundary conditions.
  const [condition] = readStep("ISO-10303-21;\nDATA;\n#1=IFCBOUNDARYNODECONDITION($,IFCBOOLEAN(.T.),IFCBOOLEAN(.F.),IFCLINEARSTIFFNESSMEASURE(5.),$,$,$);\nENDSEC;\nEND-ISO-10303-21;\n").entities.values();
  assert.deepEqual(condition.args.slice(1).map(isRestraintValue),[true,false,true,false,false,false]);
  assert.equal(isRestraintValue({type:'IFCBOOLEAN',value:'.T.'}),true);
  assert.equal(isRestraintValue({type:'IFCLINEARSTIFFNESSMEASURE',value:12}),true);
  assert.equal(isRestraintValue({type:'IFCBOOLEAN',value:'.F.'}),false);
  assert.equal(isRestraintValue(0),false);
  assert.equal(isRestraintValue('$'),false);
});

test('#9668: a merged reference support is still required on the derived side', () => {
  const member = { id:7, ends:[[0,0,0],[1,0,0]], links:[10] };
  const joint = {id:20,position:[0,0,0],links:[10],support:false,memberConnected:true};
  const support = {id:21,position:[0,0,0],links:[],support:true,memberConnected:false};
  const reference = mergeSupportOnlyNodes([joint,support]);
  const result = compareDerived({members:[member],nodes:[{...joint}]},{members:[member],nodes:reference});
  assert.equal(result.status,'partial');
  assert.ok(result.mismatches.some((problem)=>problem.includes('reference has support, derived #20 has no support')));
});

test('#9668: support mismatch keeps the derive row partial and names its position', () => {
  const position = [1,2,3];
  const member = { id:7, ends:[[0,0,0],[1,0,0]], links:[] };
  const result = compareDerived(
    { members:[member], nodes:[{id:1,position,links:[],support:true}] },
    { members:[member], nodes:[{id:2,position,links:[],support:false}] },
  );
  assert.equal(result.status,'partial');
  assert.ok(result.mismatches.some((problem)=>problem.includes('[1,2,3]') && problem.includes('support')));
});

test('#9668: unmatched support-only reference points remain missing', () => {
  const position = [4,5,6];
  const member = { id:7, ends:[[0,0,0],[1,0,0]], links:[] };
  const result = compareDerived(
    { members:[member], nodes:[] },
    { members:[member], nodes:[{id:3,position,links:[],support:true,memberConnected:false}] },
  );
  assert.equal(result.status,'partial');
  assert.ok(result.mismatches.some((problem)=>problem.includes('[4,5,6]') && problem.includes('support')));
  assert.equal(result.counts.referenceNodes,1);
});

test('#9923: plain Node loads the class-toggle table without the viewer loader', () => {
  const target = new URL('../apps/viewer/src/store/typeVisibilityFilter.ts',import.meta.url).href;
  const result = spawnSync(process.execPath,['--input-type=module','-e',`
    import assert from 'node:assert/strict';
    const {isTypeVisible,buildHiddenIfcTypes} = await import(${JSON.stringify(target)});
    const flags = {spaces:false,spatialZones:true,openings:true,virtualElements:true,site:true,ifcAnnotations:true};
    assert.ok(buildHiddenIfcTypes(flags).has('IfcSpace'));
    assert.equal(isTypeVisible('IfcStructuralCurveMember',flags,'physical'),false);
    assert.equal(isTypeVisible('IfcBeam',flags,'physical'),true);
  `],{encoding:'utf8',timeout:10000,env:{...process.env,NODE_OPTIONS:''}});
  assert.equal(result.status,0,result.stderr || result.error?.message);
});

test('#9668: a support on a derived orphan cannot stand in for one the matched joint lost', () => {
  const member = { id:7, ends:[[0,0,0],[1,0,0]], links:[10] };
  const reference = [
    {id:20,position:[0,0,0],links:[10],support:true,memberConnected:true},
    {id:21,position:[0,0,0],links:[],support:false,memberConnected:false},
  ];
  const derived = [
    {id:40,position:[0,0,0],links:[10],support:false,memberConnected:true},
    {id:41,position:[0,0,0],links:[],support:true,memberConnected:false},
  ];
  const result = compareDerived({members:[member],nodes:derived},{members:[member],nodes:reference});
  assert.notEqual(result.status,'pass');
  assert.ok(result.mismatches.some((problem)=>problem.includes('connection #20')));
});
