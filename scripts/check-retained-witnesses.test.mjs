// SPDX-License-Identifier: MPL-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { requiredWitnesses, checkWitnesses } from './check-retained-witnesses.mjs';

const script = resolve('scripts/check-retained-witnesses.mjs');
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'retained-witnesses-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'tests/evidence/fixture');
  await mkdir(directory, { recursive: true });
  return { root, registry: join(directory, 'witnesses.txt'), log: join(root, 'output.log') };
}

// #7955 / #8435: the lane gate must fail even if grep/shard leaves a green runner.
for (const lane of ['cli', 'viewer']) {
  test(`#8435 ${lane}: every registered scenario is mandatory despite a green filtered log`, async t => {
    const { log } = await fixture(t);
    const registrations = await requiredWitnesses('.', lane);
    assert.ok(registrations.length >= (lane === 'viewer' ? 7 : 5));
    const records = registrations.map(({ marker }) => `${lane === 'cli' ? 'ℹ ' : ''}${marker} {"assertions":"passed"}`);
    const run = () => spawnSync(process.execPath, [script, '--lane', lane, '--log', log], { encoding: 'utf8' });
    await writeFile(log, records.join('\n'));
    assert.equal(run().status, 0);
    for (const [index, registration] of registrations.entries()) {
      await writeFile(log, [...records.filter((_, i) => i !== index), '1 passed; 0 failed'].join('\n'));
      const filtered = run();
      assert.equal(filtered.status, 1, `${registration.marker} omitted by grep/shard must fail`);
      assert.ok(filtered.stderr.includes(registration.marker), filtered.stderr);
    }
    await writeFile(log, '');
    assert.equal(run().status, 1, 'all scenarios filtered out also fails');
  });
}

test('#8435 native legacy markers keep end matching; scoped lanes cannot satisfy each other', async t => {
  const { root, registry, log } = await fixture(t);
  await writeFile(registry, '# comment\nold_native\ncli\tM2-D cli:\nviewer\tM2-D viewer:\n');
  await writeFile(log, 'interleaved diagnostic sdk witness executed: old_native\n# M2-D cli: {"ok":true}\n');
  assert.equal(await checkWitnesses({ root, lane: 'native', log }), 1);
  assert.equal(await checkWitnesses({ root, lane: 'cli', log }), 1);
  await assert.rejects(checkWitnesses({ root, lane: 'viewer', log }), /Missing viewer/);
  await writeFile(log, 'sdk witness executed: old_native_longer\n');
  await assert.rejects(checkWitnesses({ root, lane: 'native', log }), /Missing native/);
});

test('#8435 output needs an exact record and JSON payload, not a test title or marker prefix', async t => {
  const { root, registry, log } = await fixture(t);
  await writeFile(registry, 'viewer\tM2-D viewer:\n');
  for (const output of ['test title M2-D viewer: {}', 'M2-D viewer:longer {}']) {
    await writeFile(log, output);
    await assert.rejects(checkWitnesses({ root, lane: 'viewer', log }), /Missing viewer/);
  }
  for (const payload of ['malformed', 'null', '1']) {
    await writeFile(log, `M2-D viewer: ${payload}`);
    await assert.rejects(checkWitnesses({ root, lane: 'viewer', log }), /Malformed viewer witness M2-D viewer:.*Remedy:.*(?:valid JSON|JSON object)/);
  }
  await writeFile(log, '\u001b[32mM2-D viewer: {"ok":true}\u001b[0m\n');
  assert.equal(await checkWitnesses({ root, lane: 'viewer', log }), 1);
});

test('#8435 missing logs, missing registrations and unknown scope fail closed', async t => {
  const { root, registry, log } = await fixture(t);
  await writeFile(registry, 'viewer\tM2-D viewer:\n');
  await assert.rejects(checkWitnesses({ root, lane: 'viewer', log }), /ENOENT/);
  await assert.rejects(requiredWitnesses(root, 'cli'), /No registered/);
  await writeFile(registry, 'vewer\tM2-D viewer:\n');
  await assert.rejects(requiredWitnesses(root, 'viewer'), /Invalid witness/);
});

test('#8435 gate failures name actionable remedies, including malformed records', async t => {
  const { root, registry, log } = await fixture(t);
  const run = (...args) => spawnSync(process.execPath, [script, '--root', root, ...args], { encoding: 'utf8' });
  for (const args of [[], ['--wrong', 'flag'], ['--lane', 'typo', '--log', log], ['--lane', 'viewer', '--log', log]]) {
    const result = run(...args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Remedy:/);
  }
  await writeFile(registry, 'viewer\tM2-D viewer:\n');
  for (const output of ['', 'M2-D viewer: broken']) {
    await writeFile(log, output);
    const result = run('--lane', 'viewer', '--log', log);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /M2-D viewer:/);
    assert.match(result.stderr, /Remedy:/);
  }
  const unreadable = run('--lane', 'viewer', '--log', root);
  assert.equal(unreadable.status, 1);
  assert.match(unreadable.stderr, /Cannot read viewer witness log.*Remedy:/);
});

test('#8435 the old Revit wall witness cannot satisfy registered V5C coverage', async t => {
  const { log } = await fixture(t);
  const required = await requiredWitnesses('.', 'cli');
  assert.ok(required.some(r => r.marker === 'M2-D cli-real-revit-v5c:'));
  await writeFile(log, required.map(r => `${r.marker.replace('revit-v5c:', 'revit:')} {}`).join('\n'));
  await assert.rejects(checkWitnesses({ lane: 'cli', log }), /cli-real-revit-v5c:/);
});
