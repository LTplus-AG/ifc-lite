/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';

const repo = resolve(import.meta.dirname, '..');
// Interpret workflow configuration and execute its shell steps. This is an
// orchestration contract, not an assertion that a source-code string exists.
const workflow = parse(readFileSync(join(repo, '.github/workflows/test.yml'), 'utf8'));
const setup = workflow.jobs['revert-oracle'].steps.find(step => step.uses === './.github/actions/setup-revert-oracle');
const action = parse(readFileSync(join(repo, setup.uses, 'action.yml'), 'utf8'));
const fixture = Buffer.from('ISO-10303-21;\n/* manifested oracle fixture */\nEND-ISO-10303-21;\n');
const hash = createHash('sha256').update(fixture).digest('hex');

/** Only the action's declared comparison/AND grammar is supported. Unknown
 * configuration fails this runner instead of silently treating it as true. */
function enabled(condition, context) {
  if (condition === undefined) return true;
  return condition.slice(3, -2).trim().split('&&').every(term => {
    const parts = term.trim().split(/\s+/);
    const [key, operator, quotedValue] = parts;
    if (parts.length !== 3 || (operator !== '!=' && operator !== '==')) throw new Error(`unsupported provisioning condition: ${condition}`);
    const value = quotedValue.slice(1, -1);
    if (!Object.hasOwn(context, key)) throw new Error(`unknown provisioning input: ${key}`);
    return operator === '==' ? context[key] === value : context[key] !== value;
  });
}

function runShell(script, cwd, env) {
  return new Promise((accept, reject) => {
    const child = spawn('bash', ['-e', '-c', script], { cwd, env });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.on('error', reject);
    child.on('close', code => accept({ code, output }));
  });
}

async function provision({ browser = false, cache = 'miss' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'oracle-fixture-provision-'));
  const commands = join(root, 'commands.txt');
  const server = createServer((_request, response) => { response.end(fixture); });
  await new Promise(accept => server.listen(0, '127.0.0.1', accept));
  try {
    const scriptDir = join(root, 'scripts/fixtures');
    mkdirSync(scriptDir, { recursive: true });
    for (const file of ['fetch-fixtures.mjs', 'download-url.mjs', 'manifest-validation.mjs', 'zip-member.mjs']) {
      copyFileSync(join(repo, 'scripts/fixtures', file), join(scriptDir, file));
    }
    mkdirSync(join(root, 'tests/models'), { recursive: true });
    writeFileSync(join(root, 'tests/models/manifest.json'), JSON.stringify({ version: 1,
      base_url: `http://127.0.0.1:${server.address().port}`, release_tag: 'test',
      files: [{ path: 'native.ifc', sha256: hash, size: fixture.length }] }));
    const bin = join(root, 'bin'); mkdirSync(bin);
    // Only the external pnpm launcher is substituted. Fetch and SHA/size
    // verification execute the real canonical fixture CLI against the server.
    writeFileSync(join(bin, 'pnpm'), `#!/bin/bash\nset -e\nprintf '%s\\n' "$*" >> "$TASK_COMMAND_LOG"\ncase "$*" in\nfixtures) exec node scripts/fixtures/fetch-fixtures.mjs ;;\nfixtures:check) exec node scripts/fixtures/fetch-fixtures.mjs --check ;;\n'exec playwright install ffmpeg') exit 0 ;;\n*) echo 'unexpected launcher command' >&2; exit 2 ;;\nesac\n`, { mode: 0o755 });
    const browserExpression = setup.with.browser;
    const callerOutputs = { 'steps.browser.outputs.needed': String(browser) };
    const browserInput = callerOutputs[browserExpression.slice(3, -2).trim()] ?? browserExpression;
    const context = { 'inputs.python': 'none', 'inputs.rust': 'false', 'inputs.browser': browserInput,
      'steps.fixtures-cache.outputs.cache-hit': String(cache !== 'miss') };
    // The Node-only frontend job invokes the same local setup action with
    // browser.needed=false. No browser-dependent caller condition may bypass it.
    assert.ok(setup);
    assert.equal(enabled(setup.if, context), true);
    let result = { code: 0, output: '' };
    for (const step of action.runs.steps) {
      if (!enabled(step.if, context)) continue;
      if (step.id === 'fixtures-cache') {
        const path = join(root, step.with.path);
        mkdirSync(path, { recursive: true });
        if (cache === 'hit') writeFileSync(join(path, 'native.ifc'), fixture);
        if (cache === 'corrupt') writeFileSync(join(path, 'native.ifc'), Buffer.alloc(fixture.length));
        continue;
      }
      if (!step.run) throw new Error(`unexpected enabled infrastructure action: ${step.uses}`);
      result = await runShell(step.run, root, { ...process.env, PATH: `${bin}:${process.env.PATH}`,
        TASK_COMMAND_LOG: commands, PYTHON_MODE: 'none', RUST_MODE: 'false', BROWSER_MODE: browserInput });
      if (result.code !== 0) break;
    }
    return { ...result, calls: (() => { try { return readFileSync(commands, 'utf8').trim().split('\n'); }
      catch (error) { if (error.code === 'ENOENT') return []; throw error; } })(),
    bytes: (() => { try { return readFileSync(join(root, 'tests/models/native.ifc')); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; } })() };
  } finally {
    await new Promise(accept => server.close(accept));
    rmSync(root, { recursive: true, force: true });
  }
}

test('#7231 Node-only oracle cache miss fetches and verifies manifested bytes without a browser toolchain', async () => {
  const result = await provision();
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(result.calls, ['fixtures', 'fixtures:check']);
  assert.deepEqual(result.bytes, fixture);
});

test('#7231 Node-only oracle cache hit still verifies the restored fixture', async () => {
  const result = await provision({ cache: 'hit' });
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(result.calls, ['fixtures:check']);
  assert.deepEqual(result.bytes, fixture);
});

for (const cache of ['corrupt', 'absent']) {
  test(`#7231 Node-only oracle refuses a ${cache} cache hit before native tests can silently skip`, async () => {
    const result = await provision({ cache });
    assert.notEqual(result.code, 0);
    assert.deepEqual(result.calls, ['fixtures:check']);
  });
}

test('#7231 browser oracle retains fixture setup and its optional video encoder', async () => {
  const result = await provision({ browser: true });
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(result.calls, ['fixtures', 'fixtures:check', 'exec playwright install ffmpeg']);
  assert.deepEqual(result.bytes, fixture);
});
