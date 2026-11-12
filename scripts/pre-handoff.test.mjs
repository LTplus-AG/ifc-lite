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

test('an oracle over contrast harness tests is a named gap, not a launch failure, when the harness has no browser', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'handoff-contrast-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'apps/viewer/src/test/contrast'), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{}');
  writeFileSync(join(root, 'apps/viewer/package.json'), '{"scripts":{"test":"tsx --test"}}');
  const harnessTest = 'apps/viewer/src/test/contrast/x.contrast.test.tsx';
  const plainTest = 'apps/viewer/src/test/contrast/plain.test.ts';
  writeFileSync(join(root, harnessTest), "import { withThemedPage } from './render-harness.js';\n");
  writeFileSync(join(root, plainTest), "import { contrastRatio } from './wcag';\n");

  const missing = oraclePrerequisites(root, { test: harnessTest }, 'unused', () => 'missing');
  assert.match(missing, /Google Chrome for the contrast harness \(1 test file\(s\)/);
  assert.equal(runGates(root, [{ name: 'witness', unavailable: missing, args: ['-e', 'process.exit(9)'] }], () => {})[0].result, 'SKIPPED');
  assert.doesNotMatch(oraclePrerequisites(root, { test: harnessTest }, 'unused', () => 'system-chrome') ?? '', /contrast harness/);
  // Counted, not thrown: oraclePrerequisites catches a probe error, so a throw here would pass unnoticed.
  let probes = 0;
  const counted = () => { probes += 1; return 'missing'; };
  assert.doesNotMatch(oraclePrerequisites(root, { test: plainTest }, 'unused', counted) ?? '', /contrast/);
  assert.equal(probes, 0, 'a test that does not use the harness is never probed');
});

test('a contrast browser probe that cannot run is a named gap, not a thrown failure', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'handoff-contrast-probe-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'apps/viewer/src/test'), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{}');
  writeFileSync(join(root, 'apps/viewer/package.json'), '{"scripts":{"test":"tsx --test"}}');
  const dynamic = 'apps/viewer/src/test/dynamic.layout.test.tsx';
  writeFileSync(join(root, dynamic), "const h = await import('@/test/contrast/render-harness.js');\n");
  const broken = () => { throw new Error('contrast browser probe failed: tsx exited 1\nstack'); };
  assert.match(oraclePrerequisites(root, { test: dynamic }, 'unused', broken), /a contrast browser answer \(contrast browser probe failed: tsx exited 1\)/);
});
