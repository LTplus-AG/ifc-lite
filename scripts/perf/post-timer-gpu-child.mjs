/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { readFileSync, readdirSync, readlinkSync, writeFileSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { PROFILES, requireOwnedChrome } from './gpu-control.mjs';
import { processIdentity } from './interleaved-cleanup.mjs';
import { POST_TIMER_CHILD_INPUTS } from './post-timer-gpu-qualification.mjs';
import { createPostTimerGpuReadback } from './post-timer-gpu-readback.mjs';
import { postTimerGpuReadbackControl } from './post-timer-gpu-readback-control.mjs';
const output = process.argv[2];
if (!output || process.platform !== 'linux' || process.env.CI !== 'true' || !process.env.DEBUG?.split(',').includes('pw:browser')) throw new Error('Hosted Linux/CI DEBUG=pw:browser and fresh output required');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const row = { status: 'started', scope: 'post-timer-inputs-v1 standalone byte controls; no IFC/pixels/timing', events: [], retries: 0, startedUTC: new Date().toISOString() };
let browser, server, created = false, phase = 'setup', eventBytes = 0;
function event(kind, value) {
  const text = String(value), bytes = Buffer.byteLength(text);
  if (row.events.length >= 1000 || bytes > 4096 || eventBytes + bytes > 1024 * 1024) { row.eventPrefixRefused = true; return; }
  row.events.push({ kind, text, phase }); eventBytes += bytes;
}
async function bounded(promise, ms) {
  let timer;
  try { return await Promise.race([promise, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Owned child deadline')), ms); })]); }
  finally { clearTimeout(timer); }
}
function chromeWitness() {
  const pids = readdirSync('/proc').filter(p => /^\d+$/.test(p));
  if (pids.length > 4096) throw new Error('Process census bound');
  const candidates = [];
  for (const pid of pids) {
    const identity = processIdentity(pid); if (identity?.ppid !== process.pid) continue;
    const verify = () => { const now = processIdentity(pid); if (!now || now.startTime !== identity.startTime || now.ppid !== process.pid) throw new Error('Chrome ownership changed'); };
    verify(); const raw = readFileSync(`/proc/${pid}/cmdline`); verify(); if (raw.length > 65536) throw new Error('Owned argv bound');
    const args = raw.toString().split('\0').filter(Boolean);
    if (args.some(a => a.startsWith('--type=')) || !PROFILES[1].args.every(a => args.includes(a))) continue;
    verify(); const executable = readlinkSync(`/proc/${pid}/exe`); verify();
    if (!/\/(chrome|google-chrome(?:-stable)?)$/.test(executable)) throw new Error('Owned executable is not Chrome');
    const sha256 = sha(readFileSync(`/proc/${pid}/exe`)); verify(); candidates.push({ identity, arguments: args, executable, sha256 });
  }
  return requireOwnedChrome(candidates, process.pid, PROFILES[1].args);
}
const handlers = ['SIGTERM', 'SIGINT'].map(signal => [signal, () => { row.interrupted = signal; event('interrupted', signal); }]);
for (const [signal, handler] of handlers) process.on(signal, handler);
try {
  writeFileSync(output, JSON.stringify(row), { flag: 'wx' }); created = true;
  row.harness = { head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 5000 }).trim(),
    node: { version: process.version, executable: realpathSync(process.execPath), sha256: sha(readFileSync(process.execPath)) }, files: {} };
  for (const path of POST_TIMER_CHILD_INPUTS) row.harness.files[path] = sha(readFileSync(path));
  server = createServer((_request, response) => { response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' }); response.end('<!doctype html><title>Post-timer inputs control</title>'); });
  await bounded(new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }), 5000);
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: [...PROFILES[1].args], timeout: 15000 });
  row.chrome = { version: browser.version(), ...chromeWitness() };
  const page = await browser.newPage();
  page.on('console', message => event('console-' + message.type(), message.text()));
  page.on('pageerror', error => event('pageerror', error)); page.on('crash', () => event('crash', 'page crashed'));
  await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: 'load', timeout: 10000 });
  phase = 'gpu-callback'; row.gpu = await bounded(page.evaluate(postTimerGpuReadbackControl, createPostTimerGpuReadback.toString()), 45000);
  if (row.gpu.status !== 'observed-pending-outer-qualification') throw new Error('Actual GPU controls refused');
  row.status = 'observed-pending-post-timer-inputs-v1';
} catch (error) { row.status = 'refused'; row.reason = String(error); }
finally {
  phase = 'teardown';
  try {
    await bounded(Promise.all([browser?.close(), server && new Promise((resolve, reject) => {
      server.closeAllConnections(); server.close(error => error ? reject(error) : resolve());
    })]), 30000); row.browserClose = 'complete';
  } catch (error) { row.browserClose = 'refused'; row.status = 'refused'; row.reason ??= String(error); }
  if (row.interrupted || row.eventPrefixRefused) { row.status = 'refused'; row.reason ??= 'Interrupted or event prefix refused'; }
  row.endedUTC = new Date().toISOString();
  const bytes = JSON.stringify(row, null, 2);
  if (Buffer.byteLength(bytes) > 16 * 1024 * 1024) { row.status = 'refused'; row.reason = 'Control result bound; payload tail uncertified'; delete row.gpu; }
  if (created) writeFileSync(output, JSON.stringify(row, null, 2));
  for (const [signal, handler] of handlers) process.removeListener(signal, handler);
  console.log(JSON.stringify({ output, status: row.status, reason: row.reason }));
  if (row.status === 'refused') process.exitCode = 1;
}
