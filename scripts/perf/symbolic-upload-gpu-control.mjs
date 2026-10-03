/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// #6537 standalone hosted control; only the owned outer harness certifies it.
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { readFileSync, readdirSync, readlinkSync, writeFileSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { SYMBOLIC_CHILD_INPUTS } from './symbolic-upload-qualification.mjs';
import { PROFILES, requireOwnedChrome } from './gpu-control.mjs';
const GRAPHICS_PROFILE = PROFILES[1];
import { processIdentity, stopWitnessedProcesses } from './interleaved-cleanup.mjs';
import { installSymbolicUploadRecorder } from './symbolic-upload-recorder.mjs';
import { symbolicUploadGpuControl } from './symbolic-upload-gpu-page.mjs';

const output = process.argv[2];
if (!output || process.platform !== 'linux' || process.env.CI !== 'true' || !process.env.DEBUG?.split(',').includes('pw:browser')) {
  throw new Error('Hosted Linux/CI, DEBUG=pw:browser and fresh output path required');
}
const row = { status: 'started', scope: 'Standalone GPU upload ABI controls only; outer raw-backend/owned-process qualification pending',
  startedUTC: new Date().toISOString(), events: [], profile: GRAPHICS_PROFILE, retries: 0 };
const owned = new Map();
let browser, page, server, interrupted, phase = 'setup', monitor, eventBytes = 0, createdOutput = false;
function event(kind, text) {
  const item = { kind, text: String(text).slice(0, 4096), phase, observedUTC: new Date().toISOString() };
  const bytes = Buffer.byteLength(JSON.stringify(item));
  if (row.events.length >= 1000 || eventBytes + bytes > 1024 * 1024) { row.eventRefusal = 'bounded event prefix; tail uncertified'; return; }
  eventBytes += bytes; row.events.push(item);
}
async function bounded(promise, ms) {
  let timer;
  try { return await Promise.race([promise, new Promise((_accept, reject) => {
    timer = setTimeout(() => reject(new Error(`control deadline ${ms}ms`)), ms);
  })]); } finally { clearTimeout(timer); }
}
function census() {
  const pids = readdirSync('/proc').filter(value => /^\d+$/.test(value));
  if (pids.length > 4096) throw new Error('process census bound');
  const members = pids.map(processIdentity).filter(Boolean), ids = new Set([process.pid]);
  for (let depth = 0; depth < 32; depth++) {
    const prior = ids.size;
    for (const item of members) if (ids.has(item.ppid)) ids.add(item.pid);
    if (ids.size === prior) {
      for (const item of members) if (ids.has(item.pid) && item.pid !== process.pid) owned.set(item.pid, item);
      return members;
    }
  }
  throw new Error('owned process depth bound');
}
function chromeWitness() {
  const candidates = [];
  for (const item of census()) {
    if (item.ppid !== process.pid) continue;
    const verify = () => {
      const current = processIdentity(item.pid);
      if (!current || current.startTime !== item.startTime || current.ppid !== process.pid) throw new Error('Chrome ownership changed');
    };
    verify();
    const argvBytes = readFileSync(`/proc/${item.pid}/cmdline`);
    verify();
    if (argvBytes.length > 65536) throw new Error('owned argv bound');
    const argv = argvBytes.toString().split('\0').filter(Boolean);
    if (argv.some(value => value.startsWith('--type=')) || !GRAPHICS_PROFILE.args.every(flag => argv.includes(flag))) continue;
    verify(); const executable = readlinkSync(`/proc/${item.pid}/exe`);
    if (!/\/(chrome|google-chrome(?:-stable)?)$/.test(executable)) throw new Error('owned executable is not Chrome');
    verify(); const sha256 = createHash('sha256').update(readFileSync(`/proc/${item.pid}/exe`)).digest('hex'); verify();
    candidates.push({ identity: item, arguments: argv, executable, sha256 });
  }
  return requireOwnedChrome(candidates, process.pid, GRAPHICS_PROFILE.args);
}
const signals = ['SIGTERM', 'SIGINT'].map(signal => [signal, () => { interrupted = signal; event('interrupted', signal); }]);
for (const [signal, handler] of signals) process.on(signal, handler);
try {
  // create_new: existing evidence is never replaced.
  writeFileSync(output, JSON.stringify(row), { flag: 'wx' });
  createdOutput = true;
  row.harness = { head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 5000 }).trim(),
    node: { version: process.version, executable: realpathSync(process.execPath),
      sha256: createHash('sha256').update(readFileSync(process.execPath)).digest('hex') }, files: {} };
  for (const path of SYMBOLIC_CHILD_INPUTS) row.harness.files[path] = createHash('sha256').update(readFileSync(path)).digest('hex');
  server = createServer((_request, response) => { response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' }); response.end('<!doctype html><title>GPU upload ABI control</title>'); });
  await bounded(new Promise((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); }), 5000);
  row.origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: [...GRAPHICS_PROFILE.args], timeout: 15000 });
  row.chrome = { version: browser.version(), ...chromeWitness() };
  monitor = setInterval(() => { try { census(); } catch (error) { row.censusRefusal ??= String(error); } }, 100);
  page = await browser.newPage();
  page.on('console', message => event(`console-${message.type()}`, message.text()));
  page.on('pageerror', error => event('pageerror', error)); page.on('crash', () => event('crash', 'page crashed'));
  await page.goto(row.origin, { waitUntil: 'load', timeout: 10000 });
  phase = 'gpu-control';
  if (interrupted) throw new Error(`interrupted by ${interrupted}`);
  row.gpu = await bounded(page.evaluate(symbolicUploadGpuControl, installSymbolicUploadRecorder.toString()), 30000);
  phase = 'post-control';
  if (row.gpu.status !== 'observed-gpu-upload-input-identity') throw new Error('actual GPU byte controls refused');
  row.status = 'observed-pending-outer-hosted-qualification';
} catch (error) { row.status = 'refused'; row.reason = String(error); }
finally {
  phase = 'teardown'; clearInterval(monitor);
  const deadline = Date.now() + 30000;
  try {
    census();
    await bounded(Promise.all([browser?.close(), server && new Promise((accept, reject) => {
      server.closeAllConnections(); server.close(error => error ? reject(error) : accept());
    })]), Math.max(1, deadline - Date.now()));
    row.browserClose = 'complete';
  } catch (error) { row.browserClose = 'refused'; row.status = 'refused'; row.reason ??= String(error); }
  try { row.ownedCleanup = await stopWitnessedProcesses([...owned.values()], Math.max(1, deadline - Date.now())); }
  catch (error) { row.ownedCleanup = { status: 'refused', reason: String(error) }; }
  if (interrupted || row.censusRefusal || row.eventRefusal || row.ownedCleanup.status !== 'complete'
    || row.events.some(item => item.phase !== 'teardown' && (item.kind === 'pageerror' || item.kind === 'crash' || item.kind === 'console-error'))) {
    row.status = 'refused'; row.reason ??= interrupted ?? row.censusRefusal ?? row.eventRefusal ?? 'GPU/events/cleanup refusal';
  }
  row.endedUTC = new Date().toISOString(); row.eventBytes = eventBytes;
  try { if (createdOutput) writeFileSync(output, JSON.stringify(row, null, 2)); }
  catch (error) { console.error('GPU control evidence write failed', error); process.exitCode = 1; }
  for (const [signal, handler] of signals) process.removeListener(signal, handler);
  console.log(JSON.stringify({ output: resolve(output), status: row.status, reason: row.reason }));
  if (row.status === 'refused') process.exitCode = 1;
}
