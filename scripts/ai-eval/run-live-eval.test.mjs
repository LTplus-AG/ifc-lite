/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from './run-live-eval.mjs';
import { recordingErrors } from './lib/recording.mjs';

const KEY = 'sk-test-0123456789abcdefghijkl-not-real';
const evidence = { source: 'clash', totalRows: 1, includedRows: 1, evidence: { rows: [{ citation: 'E1', data: {} }] } };
const requests = { version: 1, tasks: [{ taskId: 'clash-summary', scene: 'clash-rev-b', evidence, request: { system: 'S', messages: [{ role: 'user', content: 'Summarize' }], maxOutputTokens: 4096 } }] };

function withServer(handler, fn) {
  const server = createServer(handler);
  return new Promise((resolve, reject) => server.listen(0, '127.0.0.1', () => {
    fn(`http://127.0.0.1:${server.address().port}/v1/chat`).then(resolve, reject).finally(() => server.close());
  }));
}
const quiet = async fn => {
  const [log, error] = [console.log, console.error];
  const lines = [];
  console.log = (...parts) => lines.push(parts.join(' ')); console.error = (...parts) => lines.push(parts.join(' '));
  try { return { code: await fn(), lines }; } finally { console.log = log; console.error = error; }
};

test('live evaluation is opt-in: without IFCLITE_AI_EVAL_LIVE nothing is sent and the exit code says so', async () => {
  let hits = 0;
  await withServer((req, res) => { hits++; res.end(); }, async url => {
    const { code, lines } = await quiet(() => main(['--providers', 'openai'], { IFCLITE_AI_EVAL_OPENAI_URL: url, IFCLITE_AI_EVAL_OPENAI_MODEL: 'm', OPENAI_API_KEY: KEY }));
    assert.equal(code, 2);
    assert.match(lines.join('\n'), /opt-in/);
  });
  assert.equal(hits, 0);
});

test('a provider without its credential is skipped with the reason; with none usable the run does not start', async () => {
  const { code, lines } = await quiet(() => main(['--providers', 'openai'], { IFCLITE_AI_EVAL_LIVE: '1', IFCLITE_AI_EVAL_OPENAI_MODEL: 'm' }));
  assert.equal(code, 2);
  assert.match(lines.join('\n'), /skipping openai: set OPENAI_API_KEY/);
});

test('--dry-run prints the plan without sending or leaking the credential', async () => {
  const { code, lines } = await quiet(() => main(['--providers', 'openai', '--dry-run', '--tasks', 'clash-summary'],
    { IFCLITE_AI_EVAL_LIVE: '1', IFCLITE_AI_EVAL_OPENAI_MODEL: 'm', OPENAI_API_KEY: KEY }));
  assert.equal(code, 0);
  assert.ok(!lines.join('\n').includes(KEY));
  assert.deepEqual(JSON.parse(lines.join('\n')).tasks, ['clash-summary']);
});

test('an end-to-end run against a local OpenAI-compatible server writes recordings, receipts and a summary, without the credential', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-eval-live-'));
  writeFileSync(join(dir, 'requests.json'), JSON.stringify(requests));
  let received = null;
  await withServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      received = { auth: req.headers.authorization, body: JSON.parse(body) };
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: {"choices":[{"delta":{"content":"One finding [E1]."}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":30,"completion_tokens":5}}\n\ndata: [DONE]\n\n');
    });
  }, async url => {
    const { code, lines } = await quiet(() => main(['--providers', 'openai', '--tasks', 'clash-summary', '--requests', join(dir, 'requests.json'), '--out', dir],
      { IFCLITE_AI_EVAL_LIVE: '1', IFCLITE_AI_EVAL_OPENAI_URL: url, IFCLITE_AI_EVAL_OPENAI_MODEL: 'free-model', OPENAI_API_KEY: KEY }));
    assert.equal(code, 0, lines.join('\n'));
  });
  assert.equal(received.auth, `Bearer ${KEY}`);
  assert.equal(received.body.temperature, 0);
  const summary = JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8'));
  assert.deepEqual([summary.receipts.length, summary.run.reportedOutputTokens, summary.results[0].violations], [1, 5, []]);
  const [name] = readdirSync(join(dir, 'recordings'));
  assert.deepEqual(recordingErrors(JSON.parse(readFileSync(join(dir, 'recordings', name), 'utf8'))), []);
  for (const file of ['summary.json', join('recordings', name)]) assert.ok(!readFileSync(join(dir, file), 'utf8').includes(KEY), `${file} leaks the credential`);
  assert.ok(existsSync(join(dir, 'requests.json')));
});
