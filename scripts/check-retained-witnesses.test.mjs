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
  for (const output of ['test title M2-D viewer: {}', 'M2-D viewer:longer {}', 'M2-D viewer: null']) {
    await writeFile(log, output);
    await assert.rejects(checkWitnesses({ root, lane: 'viewer', log }), /Missing viewer/);
  }
  await writeFile(log, 'M2-D viewer: malformed');
  await assert.rejects(checkWitnesses({ root, lane: 'viewer', log }), SyntaxError);
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
