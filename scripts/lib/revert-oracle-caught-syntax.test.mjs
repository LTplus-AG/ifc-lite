/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseRunnerOutput, hasLoadError, ASSERTION_FAILURE, LOAD_FAILURE, PASS, verdict, OBSERVED } from './revert-oracle.mjs';

function nativeRun(source) {
  const root = mkdtempSync(join(tmpdir(), 'oracle-caught-syntax-'));
  try {
    const file = join(root, 'witness.test.mjs');
    writeFileSync(file, source);
    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', file], { env, encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.error, undefined, result.error?.message);
    return { family: 'node-test', stdout: result.stdout, stderr: result.stderr, exitCode: result.status };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

const imports = "import test from 'node:test'; import assert from 'node:assert/strict';\n";

test('#7333 caught native JSON diagnostic does not erase twenty executed assertions or four positive controls', () => {
  const run = nativeRun(imports + `
    try { JSON.parse('[{"Name":"damaged"}'); }
    catch (error) { console.error('[Lists] Failed to read list definitions from localStorage', error); }
    for (let i=0;i<24;i++) test('native behavior '+i,()=>assert.equal(i<4,true));
  `);
  assert.equal(run.exitCode, 1);
  assert.match(run.stdout, /# \[Lists\] Failed to read.*SyntaxError:/);
  const parsed = parseRunnerOutput(run);
  assert.equal(parsed.kind, ASSERTION_FAILURE);
  assert.deepEqual([parsed.total, parsed.passed, parsed.failed], [24,4,20]);
  const baseline = { kind: PASS, total:24, passed:24, failed:0, evidence:[] };
  assert.equal(verdict({ baseline, reverted:parsed }).verdict, OBSERVED);
});

test('#7333 real Node syntax failure remains a failed-file loader error', () => {
  const run = nativeRun('export const broken = ;\n');
  const parsed = parseRunnerOutput(run);
  assert.equal(parsed.kind, LOAD_FAILURE);
  assert.match(parsed.evidence.join('\n'), /SyntaxError|failed the whole FILE/);
});

test('#7333 mixed native assertion and failed-file output remains a loader failure', () => {
  const red = nativeRun(imports + "test('actual invariant',()=>assert.equal(1,2));\n");
  const broken = nativeRun('export const broken = ;\n');
  assert.equal(parseRunnerOutput({ ...red, stdout:red.stdout+broken.stdout }).kind, LOAD_FAILURE);
});

test('#7333 bare and TAP-prefixed SyntaxError diagnostics remain conservative loader evidence', () => {
  for (const prefix of ['', '# ', '  # ', '  ']) {
    const run = { family:'node-test', stdout:`${prefix}SyntaxError: Unexpected token ';'\n# tests 2\n# pass 1\n# fail 1\n`, stderr:'', exitCode:1 };
    assert.equal(hasLoadError(run.stdout),true);
    assert.equal(parseRunnerOutput(run).kind,LOAD_FAILURE);
  }
});

test('#7333 prefixed application text cannot hide a requested-module or transform error', () => {
  for (const error of ["SyntaxError: The requested module './x.mjs' does not provide an export named 'x'", 'Transform failed with 1 error']) {
    const run = { family:'node-test', stdout:`# [caught] ${error}\n# tests 2\n# pass 1\n# fail 1\n`, stderr:'', exitCode:1 };
    assert.equal(parseRunnerOutput(run).kind,LOAD_FAILURE);
  }
});

test('#7333 Vitest failed-suite structure outranks caught JSON text and real assertion counts', () => {
  const stdout = "[Lists] Failed to read saved JSON SyntaxError: Unexpected end of JSON input\nFailed Suites 1\nTests 1 failed | 1 passed (2)\n";
  assert.equal(parseRunnerOutput({ family:'vitest',stdout,stderr:'',exitCode:1 }).kind,LOAD_FAILURE);
});

test('#7333 Vitest executed assertions survive caught JSON diagnostics', () => {
  const stdout = "[Lists] Failed to read saved JSON SyntaxError: Unexpected end of JSON input\nFailed Tests 1\nAssertionError: expected 1 to be 2\nTests 1 failed | 1 passed (2)\n";
  const parsed = parseRunnerOutput({ family:'vitest',stdout,stderr:'',exitCode:1 });
  assert.equal(parsed.kind,ASSERTION_FAILURE);
  assert.deepEqual([parsed.total,parsed.passed,parsed.failed],[2,1,1]);
});

test('#7333 caught JSON text never supplies missing execution evidence', () => {
  const stdout = '# [Lists] Failed to read saved JSON SyntaxError: Unexpected end of JSON input\n';
  const parsed = parseRunnerOutput({ family:'node-test',stdout,stderr:'',exitCode:1 });
  assert.notEqual(parsed.kind,ASSERTION_FAILURE);
  assert.notEqual(verdict({ baseline:{kind:PASS,total:1,passed:1,failed:0,evidence:[]}, reverted:parsed }).verdict,OBSERVED);
});
