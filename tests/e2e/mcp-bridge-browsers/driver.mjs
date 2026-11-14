/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// MCP client over `ifc-lite-mcp --bridge` stdio for the #9523 browser evidence. Every JSON-RPC line goes to
// <dir>/transcript.jsonl (pairing codes redacted). Writes <dir>/pairing-url.txt, waits until a tab pairs,
// runs the read calls (exit 1 if a read fails or the write is not refused), writes <dir>/driver-summary.json and <dir>/calls-done, then waits for <dir>/stop.
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
// Every read must succeed with the content it is meant to show, and the write must be refused; anything else
// is recorded in summary.failure and fails the run (after calls-done, so the browser side still finishes).
const read = async (name, args, check) => {
  const r = await call(name, args);
  if (!r || r.isError || !check(r)) throw new Error(`${name} failed: ${redact(JSON.stringify(r ?? null)).slice(0, 300)}`);
  return r;
};
let failure = null;
if (existsSync(`${dir}/stop`)) {
  // Every browser run reaches a granted Phase B, so stopping before any tab paired is a failure.
  summary.paired = false;
  failure = 'the browser finished before any tab paired';
  summary.failure = failure;
} else {
  summary.paired = true;
  try {
    await sleep(500);
    const tools = (await req('tools/list')).result?.tools;
    if (!tools?.length) throw new Error('tools/list returned no tools');
    summary.toolCount = tools.length;
    summary.model_list = (await read('model_list', {}, (r) => r.content?.[0]?.text)).content[0].text.slice(0, 300);
    const walls = await read('query_entities', { type: 'IfcWall', limit: 2 }, (r) => r.structuredContent?.entities?.[0]?.globalId);
    summary.query_entities = walls.content?.[0]?.text?.slice(0, 300);
    const wall = walls.structuredContent.entities[0];
    summary.get_entity_name = (await read('get_entity', { global_id: wall.globalId }, (r) => typeof r.structuredContent?.name === 'string')).structuredContent.name;
    summary.count_entities = (await read('count_entities', { group_by: 'type' }, (r) => r.content?.[0]?.text)).content[0].text.slice(0, 200);
    // The paired tab serves read tools only: a write that is not refused fails the run.
    const refused = await call('entity_set_attribute', { global_id: wall.globalId, attribute: 'Name', value: 'x' });
    summary.refusedMutation = { isError: refused?.isError, code: refused?.structuredContent?.code };
    // Only a refusal counts: an allowed write that fails validation is also isError, with another code. The
    // viewer announces read tools only, so the server answers UNSUPPORTED_OPERATION (unknown tool); READ_ONLY
    // is TabBridge's refusal for a mutating tool a tab did announce.
    if (refused?.isError !== true || !['UNSUPPORTED_OPERATION', 'READ_ONLY'].includes(summary.refusedMutation.code)) {
      throw new Error(`entity_set_attribute was not refused: ${JSON.stringify(summary.refusedMutation)}`);
    }
  } catch (err) {
    failure = String(err?.message ?? err);
    summary.failure = failure;
  }
}
writeFileSync(`${dir}/driver-summary.json`, JSON.stringify(summary, null, 2));
writeFileSync(`${dir}/calls-done`, '1');
await until(() => existsSync(`${dir}/stop`), 'the browser finishes');
child.stdin.end(); await sleep(500); child.kill();
if (failure) { console.error(failure); process.exit(1); }
