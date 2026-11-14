/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// MCP client over `ifc-lite-mcp --bridge` stdio for the #9523 browser evidence. Every JSON-RPC line goes to
// <dir>/transcript.jsonl (pairing codes redacted). Writes <dir>/pairing-url.txt, waits until a tab pairs,
// runs the read calls (exit 1 if the write is not refused), writes <dir>/driver-summary.json and <dir>/calls-done, then waits for <dir>/stop.
// Usage: node driver.mjs <cli.js> <viewerUrl> <dir>
import { spawn } from 'node:child_process';
import { appendFileSync, writeFileSync, existsSync } from 'node:fs';

const [cli, viewerUrl, dir] = process.argv.slice(2);
const T = `${dir}/transcript.jsonl`;
writeFileSync(T, '');
// Redact before any truncation, so a cut never leaves part of a code behind.
const redact = (s) => s.replace(/code=[A-Z0-9-]+/g, 'code=<redacted>').replace(/[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){3}/g, '<code>');
const log = (d, line) => appendFileSync(T, JSON.stringify({ t: new Date().toISOString(), dir: d, line: redact(line) }) + '\n');
const child = spawn(process.execPath, [cli, '--bridge', '--bridge-port', '0', '--bridge-viewer-url', viewerUrl], { stdio: ['pipe', 'pipe', 'pipe'] });
let buf = '';
const lines = [];
child.stdout.setEncoding('utf8').on('data', (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const l = buf.slice(0, i); buf = buf.slice(i + 1);
    if (l) { log('bridge->agent', l); lines.push(JSON.parse(l)); }
  }
});
child.stderr.setEncoding('utf8').on('data', (c) => { for (const l of c.split('\n').filter(Boolean)) log('bridge-stderr', l); });
let id = 0;
const send = (m) => { const l = JSON.stringify({ jsonrpc: '2.0', ...m }); log('agent->bridge', l); child.stdin.write(l + '\n'); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const req = async (method, params = {}) => {
  const my = ++id; send({ id: my, method, params });
  for (let k = 0; k < 6000; k++) { const f = lines.find((x) => x.id === my); if (f) return f; await sleep(10); }
  throw new Error('timeout ' + method);
};
const call = async (name, args) => (await req('tools/call', { name, arguments: args })).result;
const until = async (f, what, ms = 600_000) => { for (let k = 0; k < ms / 100; k++) { if (f()) return; await sleep(100); } throw new Error('gave up: ' + what); };

await req('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'browser-evidence-driver', version: '1' } });
send({ method: 'notifications/initialized' });
const status = await call('bridge_status', {});
writeFileSync(`${dir}/pairing-url.txt`, status.structuredContent.pairingUrl);
const summary = { statusBeforePairing: redact(status.content?.[0]?.text ?? '').slice(0, 300) };
await until(() => lines.some((l) => l.method === 'notifications/tools/list_changed') || existsSync(`${dir}/stop`), 'a tab pairs');
if (existsSync(`${dir}/stop`)) {
  summary.paired = false;
} else {
  summary.paired = true;
  await sleep(500);
  summary.toolCount = (await req('tools/list')).result.tools.length;
  summary.model_list = (await call('model_list', {})).content[0].text.slice(0, 300);
  const walls = await call('query_entities', { type: 'IfcWall', limit: 2 });
  summary.query_entities = walls.content[0].text.slice(0, 300);
  const wall = walls.structuredContent.entities[0];
  summary.get_entity_name = (await call('get_entity', { global_id: wall.globalId })).structuredContent?.name;
  summary.count_entities = (await call('count_entities', { group_by: 'type' })).content[0].text.slice(0, 200);
  const refused = await call('entity_set_attribute', { global_id: wall.globalId, attribute: 'Name', value: 'x' });
  summary.refusedMutation = { isError: refused.isError, code: refused.structuredContent?.code };
}
// The paired tab serves read tools only: a write that is not refused fails the run.
const failure = summary.paired && summary.refusedMutation.isError !== true
  ? `entity_set_attribute was not refused: ${JSON.stringify(summary.refusedMutation)}` : null;
if (failure) summary.failure = failure;
writeFileSync(`${dir}/driver-summary.json`, JSON.stringify(summary, null, 2));
writeFileSync(`${dir}/calls-done`, '1');
await until(() => existsSync(`${dir}/stop`), 'the browser finishes');
child.stdin.end(); await sleep(500); child.kill();
if (failure) { console.error(failure); process.exit(1); }
