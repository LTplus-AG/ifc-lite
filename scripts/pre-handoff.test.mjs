/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gateCommands, runGates, oraclePrerequisites } from './pre-handoff.mjs';

test('#7955 handoff keeps running after failures and distinguishes missing prerequisites', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'handoff-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'package.json'), '{}');
  const lines = [];
  const rows = runGates(root, [
    { name: 'bad', args: ['-e', 'process.exit(7)'] },
    { name: 'good', args: ['-e', 'console.log("executed")'] },
    { name: 'deps', deps: ['nonexistent-handoff-dependency'], args: ['-e', 'process.exit(1)'] },
    { name: 'dist', needs: 'absent/dist', args: ['-e', 'process.exit(1)'] },
  ], (line) => lines.push(line));
  assert.deepEqual(rows.map((row) => row.result), ['FAIL', 'PASS', 'SKIPPED', 'SKIPPED']);
  assert.equal(rows[0].detail, 'exit 7');
  assert.ok(lines.some((line) => line.includes('executed')));
  assert.equal(lines.filter((line) => line.startsWith('SKIPPED')).length, 2);
});

test('#7955 selected base reaches diff-sensitive gates and license invocation is read-only', () => {
  const gates = gateCommands('custom/base');
  assert.ok(gates.find((gate) => gate.name === 'module-size').args.includes('custom/base'));
  assert.ok(gates.find((gate) => gate.name === 'source-text-assertions').args.includes('custom/base'));
  assert.ok(gates.find((gate) => gate.name === 'silent-revert').args.includes('custom/base'));
  assert.ok(gates.find((gate) => gate.name === 'license-headers').args.includes('--check'));
});

test('#7955 a registered witness with an unavailable runner is explicitly skipped', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'handoff-runner-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'packages/example'), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{}');
  writeFileSync(join(root, 'packages/example/package.json'), '{"scripts":{"test":"vitest run"}}');
  writeFileSync(join(root, 'packages/example/witness.test.mjs'), '');
  const unavailable = oraclePrerequisites(root, { test: 'packages/example/witness.test.mjs' }, 'unused');
  assert.match(unavailable, /vitest/);
  const rows = runGates(root, [{ name: 'witness', unavailable, args: ['-e', 'process.exit(9)'] }], () => {});
  assert.equal(rows[0].result, 'SKIPPED');
});
