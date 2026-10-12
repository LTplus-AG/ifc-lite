/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runLive } from './live.mjs';
import { REPO_ROOT } from './recording.mjs';
import { readJson } from './test-root.mjs';

const manifest = readJson(join(REPO_ROOT, 'tests/ai-eval/manifest.json'));
const captured = { version: 1, tasks: [{ taskId: 'clash-summary', scene: 'clash-rev-b',
  evidence: { source: 'clash', totalRows: 0, includedRows: 0, evidence: { rows: [] } },
  request: { system: 'Controlled credential-output invariant', messages: [{ role: 'user', content: 'Report no findings.' }], maxOutputTokens: 32 } }] };
const stream = (kind, value) => {
  const events = kind === 'anthropic'
    ? [{ type: 'content_block_delta', delta: { type: 'text_delta', text: value } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } }]
    : [{ choices: [{ delta: { content: value } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 5 } }];
  return events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n';
};
async function peer(kind, key, status, echo) {
  const observed = [];
  const server = http.createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    observed.push({ method: request.method,
      authenticated: kind === 'anthropic' ? request.headers['x-api-key'] === key : request.headers.authorization === `Bearer ${key}`,
      payloadCredentialFree: !body.includes(key) });
    response.writeHead(status, { 'Content-Type': status === 200 ? 'text/event-stream' : 'text/plain' });
    const text = echo ? `Controlled upstream echo ${key}` : 'No findings.';
    response.end(status === 200 ? stream(kind, text) : text);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return { observed, url: `http://127.0.0.1:${address.port}/chat`,
    close: async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
// Both parsed generated receipts and actual child logs must exclude known credentials.
function generatedOutputContainsCredential(value, credential) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.includes(credential) || text.includes(JSON.stringify(credential).slice(1, -1));
}
function requestOptions(provider) {
  return { manifest, captured, providers: [provider], tasks: ['clash-summary'], repeats: 1,
    fetchImpl: fetch, runId: 'controlled-credential-output' };
}

// #6928: real authenticated HTTP responses, not an injected provider return.
for (const kind of ['openai', 'anthropic']) for (const status of [200, 500]) {
  for (const key of ['ownedQ7m2y5z8_opaqueProof', 'owned"quote\\backslash', 'xy!']) {
    test(`#6928 ${kind} HTTP${status} credential echo is refused before live output exists (${key.length} chars)`, { timeout: 5000 }, async () => {
      const remote = await peer(kind, key, status, true);
      try {
        let result, error;
        try { result = await runLive(requestOptions({ kind, url: remote.url, model: 'controlled', key })); }
        catch (failure) { error = failure; }
        assert.deepEqual(remote.observed, [{ method: 'POST', authenticated: true, payloadCredentialFree: true }]);
        assert.equal(result, undefined, 'a real credential-bearing response must not become a persistable recording');
        assert.ok(error instanceof Error);
        assert.match(error.message, /configured provider credential/);
        assert.ok(!String(error).includes(key));
        assert.ok(!JSON.stringify(error).includes(JSON.stringify(key).slice(1, -1)));
      } finally { await remote.close(); }
    });
  }
}

async function child(args, env) {
  const childProcess = spawn(globalThis.process.execPath, [join(REPO_ROOT, 'scripts/ai-eval/run-live-eval.mjs'), ...args],
    { cwd: REPO_ROOT, env: { ...globalThis.process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  childProcess.stdout.on('data', data => { stdout += data; }); childProcess.stderr.on('data', data => { stderr += data; });
  const timeout = setTimeout(() => childProcess.kill('SIGTERM'), 5000);
  try { const [code] = await once(childProcess, 'close'); return { code, stdout, stderr }; }
  finally { clearTimeout(timeout); }
}
for (const status of [200, 500]) for (const echo of [true, false]) {
  test(`#6928 actual CLI HTTP${status} ${echo ? 'refuses an echoed credential without files or logs' : 'persists clean usage and response unchanged'}`, { timeout: 10000 }, async () => {
    const key = 'ownedQ7m2y5z8_opaqueProof';
    const remote = await peer('openai', key, status, echo);
    const dir = await mkdtemp(join(tmpdir(), 'ifclite-live-credential-'));
    try {
      const requests = join(dir, 'requests.json'), out = join(dir, 'result');
      await writeFile(requests, JSON.stringify(captured));
      const observed = await child(['--providers', 'openai', '--tasks', 'clash-summary', '--requests', requests, '--out', out],
        { IFCLITE_AI_EVAL_LIVE: '1', IFCLITE_AI_EVAL_OPENAI_URL: remote.url, IFCLITE_AI_EVAL_OPENAI_MODEL: 'controlled', OPENAI_API_KEY: key });
      assert.deepEqual(remote.observed, [{ method: 'POST', authenticated: true, payloadCredentialFree: true }]);
      const files = await readdir(join(out, 'recordings'));
      assert.equal(observed.code, echo ? 1 : 0);
      assert.ok(!(observed.stdout + observed.stderr).includes(key));
      if (echo) { assert.deepEqual(files, []); assert.throws(() => readJson(join(out, 'summary.json')), { code: 'ENOENT' }); }
      else {
        assert.equal(files.length, 1);
        const recording = readJson(join(out, 'recordings', files[0]));
        const summary = readJson(join(out, 'summary.json'));
        if (status === 200) {
          assert.equal(recording.response.events[0].choices[0].delta.content, 'No findings.');
          assert.equal(summary.receipts[0].outputTokens, 5);
        } else {
          assert.equal(recording.response.body, 'No findings.');
          assert.equal(summary.receipts[0].outcome, 'error');
          assert.equal(summary.receipts[0].usageReported, false);
        }
        assert.equal(summary.receipts[0].status, status);
        assert.equal(generatedOutputContainsCredential({ recording, summary }, key), false);
      }
    } finally { await remote.close(); await rm(dir, { recursive: true, force: true }); }
  });
}

test('#6928 actual dry-run refuses a configured credential in provider metadata without sending or logging it', { timeout: 10000 }, async () => {
  const key = 'ownedQ7m2y5z8_opaqueProof';
  const remote = await peer('openai', key, 200, false);
  try {
    const dryRunOutcome = await child(['--providers', 'openai', '--dry-run'], {
      IFCLITE_AI_EVAL_LIVE: '1', IFCLITE_AI_EVAL_OPENAI_URL: `${remote.url}?configured=${key}`,
      IFCLITE_AI_EVAL_OPENAI_MODEL: 'controlled', OPENAI_API_KEY: key,
    });
    assert.deepEqual(remote.observed, []);
    assert.equal(dryRunOutcome.code, 1);
    assert.equal(dryRunOutcome.stderr.trim(), 'live evaluation plan: refusing to write (configured provider credential)');
    assert.equal(generatedOutputContainsCredential(dryRunOutcome.stdout + dryRunOutcome.stderr, key), false);
  } finally { await remote.close(); }
});
