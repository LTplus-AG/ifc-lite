/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCorpus } from '../tests/structural-coverage/lib/corpus.mjs';
import { loadPackages } from '../tests/structural-coverage/lib/packages.mjs';
import { compareDerived, measureDerivation, FRAME } from '../tests/structural-coverage/probes/capability-derive-toggle.mjs';

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
