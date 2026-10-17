/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { parse } from 'yaml';

// #7830: execute the actual workflow step with a permission-aware gh transport.
// No network writes or deployment credentials are used by this harness.
const workflow = parse(readFileSync(new URL('../.github/workflows/deploy-nightly.yml', import.meta.url), 'utf8'));
const step = workflow.jobs['advance-production'].steps.find(({ id }) => id === 'advance');
const target = 'a'.repeat(40);
const current = 'b'.repeat(40);
const repo = 'example/ifc-lite';

function advance({ state = 'ahead', token = 'deploy-test-token', rejectWrite = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'deploy-nightly-'));
  try {
    // Match the exact secret binding and GITHUB_TOKEN permissions used by Actions.
    const secrets = { DEPLOY_PAT: token };
    const env = Object.fromEntries(Object.entries(step.env).map(([key, value]) => {
      const secret = /^\$\{\{ secrets\.(\w+) \}\}$/.exec(value);
      return [key, secret ? secrets[secret[1]] ?? '' : value];
    }));
    writeFileSync(join(dir, 'gh'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const endpoint = args.find(arg => arg.startsWith('repos/'));
const method = args.includes('-X') ? args[args.indexOf('-X') + 1] : 'GET';
fs.appendFileSync(process.env.TRACE, JSON.stringify({ args, method, token: process.env.GH_TOKEN }) + '\\n');
if (method !== 'GET') {
  if (process.env.GH_TOKEN !== 'deploy-test-token' || process.env.REJECT_WRITE === 'true') {
    console.error('gh: Resource not accessible by integration (HTTP 403)');
    process.exit(1);
  }
  process.exit(0);
}
const target = '${target}', current = '${current}', repo = '${repo}';
if (endpoint === 'repos/' + repo + '/commits/main') {
  console.log(args.includes('.sha') ? target : target + '\\tgreen main');
} else if (endpoint === 'repos/' + repo + '/commits?sha=' + target + '&per_page=100') {
  console.log(JSON.stringify([{sha: target, parents: [{sha: current}], commit: {message: 'green main'}}]));
} else if (endpoint === 'repos/' + repo + '/commits/' + target + '/check-runs') {
  console.log(JSON.stringify({total_count: 1, check_runs: [{started_at: '2026-10-17', conclusion: process.env.STATE === 'red' ? 'failure' : 'success'}]}));
} else if (endpoint === 'repos/' + repo + '/commits/' + current) {
  console.log('');
} else if (endpoint === 'repos/' + repo + '/commits/' + current + '/check-runs') {
  console.log(JSON.stringify({total_count: 0, check_runs: []}));
} else if (endpoint === 'repos/' + repo + '/git/matching-refs/heads/production') {
  console.log(process.env.STATE === 'missing' ? '' : process.env.STATE === 'identical' ? target : current);
} else if (endpoint.startsWith('repos/' + repo + '/compare/')) {
  if (args.includes('.status')) {
    console.log(endpoint.endsWith(target + '...main') || process.env.STATE === 'identical' ? 'identical' : process.env.STATE === 'diverged' ? 'diverged' : 'ahead');
  } else {
    console.log('  ' + target.slice(0, 9) + ' green main');
  }
} else {
  console.error('Unexpected gh call: ' + JSON.stringify(args));
  process.exit(2);
}
`, { mode: 0o755 });
    const outputPath = join(dir, 'output');
    writeFileSync(outputPath, '');
    const result = spawnSync('bash', ['-c', step.run], {
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        ...process.env, ...env,
        PATH: `${dir}:${process.env.PATH}`,
        GH_TOKEN: 'job-test-token',
        REPO: repo, REQUESTED_REF: 'main', REQUIRE_GREEN: 'true',
        GITHUB_OUTPUT: outputPath, TRACE: join(dir, 'trace'),
        STATE: state, REJECT_WRITE: String(rejectWrite),
      },
    });
    assert.ifError(result.error);
    return {
      ...result,
      output: readFileSync(outputPath, 'utf8'),
      calls: readFileSync(join(dir, 'trace'), 'utf8').trim().split('\n').map(JSON.parse),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('#7830: green fast-forward uses deploy credential only for the unforced ref write', () => {
  const result = advance();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(workflow.permissions.contents, 'read');
  const writes = result.calls.filter(({ method }) => method !== 'GET');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].method, 'PATCH');
  assert.equal(writes[0].token, 'deploy-test-token');
  assert.ok(writes[0].args.includes(`repos/${repo}/git/refs/heads/production`));
  assert.ok(writes[0].args.includes('force=false'));
  assert.ok(writes[0].args.includes(`sha=${target}`));
  assert.ok(result.calls.filter(({ method }) => method === 'GET').every(({ token }) => token === 'job-test-token'));
  assert.equal(result.output, `sha=${target}\n`);
});

test('#7830: initial branch creation uses the deploy credential too', () => {
  const result = advance({ state: 'missing' });
  assert.equal(result.status, 0, result.stderr);
  const writes = result.calls.filter(({ method }) => method !== 'GET');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].method, 'POST');
  assert.equal(writes[0].token, 'deploy-test-token');
  assert.ok(writes[0].args.includes('ref=refs/heads/production'));
  assert.equal(result.output, `sha=${target}\n`);
});

for (const state of ['ahead', 'missing']) {
  test(`#7830: missing secret fails with setup instructions before ${state} ref write`, () => {
    const result = advance({ state, token: '' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /DEPLOY_PAT with Contents and Workflows write/);
    assert.equal(result.calls.filter(({ method }) => method !== 'GET').length, 0);
    assert.equal(result.output, '');
  });
}

test('#7830: an already deployed commit needs no deploy credential', () => {
  const result = advance({ state: 'identical', token: '' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.calls.filter(({ method }) => method !== 'GET').length, 0);
  assert.equal(result.output, `sha=${target}\n`);
});

test('#7830: rejected deploy credentials fail without falling back to GITHUB_TOKEN', () => {
  const result = advance({ rejectWrite: true });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /HTTP 403/);
  assert.equal(result.calls.filter(({ method }) => method !== 'GET').length, 1);
  assert.equal(result.output, '');
});

test('#7830: divergent production is still refused before any write', () => {
  const result = advance({ state: 'diverged' });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /holds commits main does not/);
  assert.equal(result.calls.filter(({ method }) => method !== 'GET').length, 0);
  assert.equal(result.output, '');
});

test('#7830: deploy credential does not bypass the green gate', () => {
  const result = advance({ state: 'red' });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /No commit at or below/);
  assert.equal(result.calls.filter(({ method }) => method !== 'GET').length, 0);
  assert.equal(result.output, '');
});
