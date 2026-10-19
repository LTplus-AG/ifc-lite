/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { cohort } from './lib/exact-route-cohort.mjs';
import { draftGraph, compareReviewedGraph } from './exact-route-graph.mjs';
import { packageInputs } from './exact-route-inputs.mjs';
import { sha256 } from './exact-route-source.mjs';
const receipts = c => c.dirs.map(d => JSON.parse(readFileSync(join(d, 'receipt.json'))));
function pin(c, change = () => {}) {
  const witness = draftGraph(...receipts(c)); change(witness);
  const bytes = JSON.stringify(witness), graphPath = join(c.dirs[1], 'reviewed-graph.json');
  writeFileSync(graphPath, bytes); return { graphPath, graphSha256: sha256(bytes) };
}
test('source-pinned native workspace additions and edges qualify with every unit policy retained', t => {
  const c = cohort(t, { workspaceGraph: true });
  assert.throws(() => c.compare());
  const result = c.compare(pin(c)); assert.equal(result.equal, true);
  assert.equal(result.graph.added.length, 2);
  assert.equal(result.graph.sides[0].units, 5); assert.equal(result.graph.sides[1].units, 7);
});
test('explicit workspace removal is supported without shrinking provenance requirements', t => {
  const c = cohort(t, { workspaceGraph: true }), [a, b] = receipts(c);
  const bytes = JSON.stringify(draftGraph(b, a));
  const result = compareReviewedGraph(b, a, { bytes }, sha256(bytes));
  assert.equal(result.removed.length, 2); assert.equal(result.added.length, 0);
});
for (const kind of ['args', 'profile', 'features', 'external-source', 'external-args']) {
  test(`identical captures/example policy cannot waive ${kind} drift even in a re-pinned graph`, t => {
    const c = cohort(t, { workspaceGraph: true });
    c.compiler(({ events, artifacts }) => {
      const i = kind.startsWith('external') ? 0 : artifacts.findIndex(a => a.target.name === 'ifc-lite-geometry');
      if (kind === 'profile') artifacts[i].profile.opt_level = '0';
      else if (kind === 'features') artifacts[i].features.push('unexpected');
      else if (kind === 'external-source') events[i].inputsBefore['lib.rs'] = events[i].inputsAfter['lib.rs'] = 'b'.repeat(64);
      else events[i].args.push('-C', 'debug-assertions=yes');
    });
    assert.throws(() => c.compare(pin(c)));
  });
}
test('changed added-unit compiler arguments cannot reuse the reviewed witness', t => {
  const c = cohort(t, { workspaceGraph: true }), evidence = pin(c);
  c.compiler(({ events }) => events.find(e => e.package.name === 'ifc-lite-imported-geometry').args.push('-C', 'opt-level=0'));
  assert.throws(() => c.compare(evidence), /witness mismatch/);
});
test('unknown additions require explicit workspace package ownership authorization', t => {
  const c = cohort(t, { workspaceGraph: true });
  assert.throws(() => c.compare(pin(c, w => w.workspacePackages = ['ifc-lite-geometry-runtime'])), /unknown graph addition/);
});
for (const mutation of [w => w.sides[1].source.tree = 'a'.repeat(40),
  w => w.sides[1].units.pop(), w => w.sides[1].units[0].manifestSha256 = 'a'.repeat(64),
  w => w.sides[1].units.at(-1).links.reverse(), w => w.added.pop()]) {
  test('independently pinned but false source/unit/edge expectation refuses', t => {
    const c = cohort(t, { workspaceGraph: true }); assert.throws(() => c.compare(pin(c, mutation)));
  });
}
test('witness bytes require independent digest; receipt labels and edited witnesses cannot authorize', t => {
  const c = cohort(t, { workspaceGraph: true }), evidence = pin(c);
  assert.throws(() => c.compare({ graphPath: evidence.graphPath }));
  writeFileSync(evidence.graphPath, readFileSync(evidence.graphPath, 'utf8') + '\n');
  assert.throws(() => c.compare(evidence), /digest/);
});
test('unlisted external transition refuses; a literal reviewed source/policy transition qualifies', t => {
  const c = cohort(t, { workspaceGraph: true });
  c.compiler(({ events }) => events[0].args.push('-C', 'opt-level=2'));
  assert.throws(() => c.compare(pin(c)), /external source\/policy/);
  assert.equal(c.compare(pin(c, w => w.externalTransitions = [w.sides[1].units[0].key])).equal, true);
  const evidence = pin(c, w => w.externalTransitions = [w.sides[1].units[0].key]);
  c.compiler(({ events }) => events[0].args.push('-C', 'overflow-checks=yes'));
  assert.throws(() => c.compare(evidence));
});
test('source-pinned feature declaration changes preserve enabled-feature and codegen checks', t => {
  const c = cohort(t, { workspaceGraph: true, featureGraph: true });
  const before = 'cfg(feature, values("default"))', after = 'cfg(feature, values("default", "triangulation-alt"))';
  for (const i of [0, 1]) c.compiler(({ events }) => {
    for (const e of events.filter(e => e.package.name === 'ifc-lite-processing')) e.args.push('--check-cfg', i ? after : before);
  }, i);
  assert.throws(() => c.compare(pin(c)), /common workspace compiler policy/);
  const authorize = w => { w.featureDeclarations = w.sides[0].units.filter(u => u.package === 'ifc-lite-processing').map(u =>
    ({ unit: u.key, manifest: u.manifestPath, before, after })); };
  assert.equal(c.compare(pin(c, authorize)).equal, true);
  c.compiler(({ events }) => events.find(e => e.package.name === 'ifc-lite-processing').args.push('--cfg', 'different_enabled_behavior'));
  assert.throws(() => c.compare(pin(c, authorize)), /common workspace compiler policy/);
});
test('common edge order cannot be normalized away by a reviewed graph', t => {
  const c = cohort(t, { workspaceGraph: true });
  c.compiler(({ events }) => {
    const e = events.at(-1), pairs = [];
    for (let i = e.args.indexOf('--extern'); i < e.args.length; i += 2) pairs.push(e.args.slice(i, i + 2));
    e.args.splice(e.args.indexOf('--extern'), pairs.flat().length, ...pairs.reverse().flat());
  });
  assert.throws(() => c.compare(pin(c)), /common dependency order/);
});

test('new external unit requires exact source, policy, owner edge and explicit expected transition', t => {
  const c = cohort(t, { workspaceGraph: true, externalGraph: true });
  c.compiler(({ events, artifacts, files, context }) => {
    const root = join(c.dirs[1], 'external-added-source'); mkdirSync(root);
    writeFileSync(join(root, 'Cargo.toml'), '[package]\nname = "external-added"\nversion = "1.0.0"\n');
    writeFileSync(join(root, 'lib.rs'), '// external added source');
    const event = structuredClone(events[0]), unit = structuredClone(artifacts[0]);
    event.package = { ...event.package, root, name: 'external-added' };
    const source = join(root, 'lib.rs'), file = join(c.dirs[1], 'artifacts/libexternal_added-fixture.rlib');
    writeFileSync(file, 'new external compiler artifact'); files[file] = sha256(readFileSync(file));
    event.args = ['--crate-name', 'external_added', source, '--out-dir', join(c.dirs[1], 'artifacts'), '--crate-type', 'lib', '-C', 'opt-level=3'];
    event.inputsBefore = packageInputs(root); event.inputsAfter = structuredClone(event.inputsBefore);
    event.outputs = { [file]: files[file] };
    unit.package_id = 'registry+fixture#external-added@1.0.0'; unit.target = { name: 'external-added', kind: ['lib'], src_path: source };
    unit.filenames = [file]; events.push(event); artifacts.push(unit);
    const consumer = events.find(e => e.package.name === 'ifc-lite-processing');
    consumer.args.push('--extern', `external_added=${file}`);
    consumer.externInputs[file] = consumer.externAfter[file] = files[file];
    assert.equal(context.source.source, c.branch);
  });
  assert.throws(() => c.compare(pin(c)), /unknown graph addition/);
  const expected = pin(c, w => w.externalTransitions = w.added.filter(k => k.includes('external-added')));
  assert.equal(c.compare(expected).equal, true);
  c.compiler(({ events }) => { const e = events.find(e => e.package.name === 'external-added'); e.inputsBefore['lib.rs'] = e.inputsAfter['lib.rs'] = 'c'.repeat(64); });
  assert.throws(() => c.compare(expected), /witness mismatch/);
});

test('common workspace edge change requires the changed owning source manifest', t => {
  const c = cohort(t, { workspaceGraph: true });
  c.compiler(({ events, artifacts, files }) => {
    const core = events.find(e => e.package.name === 'ifc-lite-core'), file = artifacts[0].filenames[0];
    core.args.push('--extern', `external_fixture=${file}`);
    core.externInputs[file] = core.externAfter[file] = files[file];
  });
  assert.throws(() => c.compare(pin(c)), /owning Cargo manifest/);
});
