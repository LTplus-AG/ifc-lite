/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { appendFileSync, writeFileSync, readFileSync, readlinkSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { CANVAS, PROFILES, COLORS, RAW_LIMITS, rgba, requirePixels, requireOwnedChrome } from './gpu-control.mjs';
import { canvasControl, pngCenter } from './gpu-page.mjs';
import { fileHash } from './interleaved-assets.mjs';
import { processIdentity } from './interleaved-cleanup.mjs';

const [name, directory] = process.argv.slice(2);
const profile = PROFILES.find(value => value.name === name);
if (!profile || !directory) throw new Error('Known fixed profile and output directory required');
const output = join(directory, `${name}.json`);
const row = { profile: name, status: 'started', startedUTC: new Date().toISOString(), events: [], colors: [],
  requested: { channel: 'chrome', headless: true, args: profile.args, canvas: CANVAS },
  scope: 'Standalone graphics environment only; no IFC, viewer, fidelity or performance verdict.' };
let browser, page, server, phase = 'setup', eventBytes = 0;
const event = value => {
  if (row.diagnosticRefusal) return;
  const item = { observedUTC: new Date().toISOString(), phase, ...value };
  let line = `${JSON.stringify(item)}\n`, bytes = Buffer.byteLength(line);
  if (row.events.length >= RAW_LIMITS.events - 1 || eventBytes + bytes > RAW_LIMITS.eventBytes - 512) {
    row.diagnosticRefusal = 'Event limit reached; retained prefix only, tail uncertified';
    item.kind = 'diagnostic-refusal'; item.text = row.diagnosticRefusal;
    line = `${JSON.stringify({ observedUTC: item.observedUTC, phase, kind: item.kind, text: item.text })}\n`; bytes = Buffer.byteLength(line);
  }
  row.events.push(JSON.parse(line));
  eventBytes += bytes; appendFileSync(join(directory, `${name}.events.jsonl`), line);
};
async function bounded(promise, ms) {
  let timer;
  try { return await Promise.race([promise, new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Control operation deadline ${ms}ms`)), ms);
  })]); } finally { clearTimeout(timer); }
}
function save() { writeFileSync(output, JSON.stringify(row, null, 2)); }
async function ownedChrome() {
  const pids = readdirSync('/proc').filter(value => /^\d+$/.test(value)), records = [];
  if (pids.length > 4096) throw new Error('Process census bound exceeded');
  const verify = witness => {
    const current = processIdentity(witness.pid);
    if (!current || current.pid !== witness.pid || current.startTime !== witness.startTime
      || current.ppid !== process.pid || witness.ppid !== process.pid) throw new Error('Chrome ownership changed during capture');
  };
  for (const pid of pids) {
    const identity = processIdentity(pid);
    if (!identity || identity.ppid !== process.pid) continue;
    verify(identity);
    const bytes = readFileSync(`/proc/${identity.pid}/cmdline`);
    if (bytes.length > 65536 || records.length >= 16) throw new Error('Owned command-line capture bound exceeded');
    verify(identity);
    records.push({ identity, arguments: bytes.toString('utf8').split('\0').filter(Boolean) });
  }
  const main = requireOwnedChrome(records, process.pid, profile.args);
  verify(main.identity);
  main.executable = readlinkSync(`/proc/${main.identity.pid}/exe`);
  if (!/^(chrome|google-chrome(?:-stable)?)$/.test(main.executable.split('/').at(-1))) throw new Error('Owned executable is not Chrome');
  verify(main.identity);
  main.sha256 = await fileHash(`/proc/${main.identity.pid}/exe`);
  verify(main.identity);
  return { ...main, producer: 'Direct Linux child; PID/startTime/ppid fenced before and after reads' };
}
try {
  save();
  writeFileSync(join(directory, `${name}.events.jsonl`), '', { flag: 'wx' });
  server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
    response.end(`<!doctype html><style>html,body{margin:0}canvas{display:block}</style><canvas width="${CANVAS.width}" height="${CANVAS.height}"></canvas>`);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  row.origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: [...profile.args], timeout: 15000 });
  row.commandLine = await bounded(ownedChrome(), 5000);
  const cdp = await browser.newBrowserCDPSession();
  row.systemInfo = await bounded(cdp.send('SystemInfo.getInfo'), 5000);
  row.chrome = { version: browser.version(), executable: row.commandLine.executable,
    sha256: row.commandLine.sha256, identity: row.commandLine.identity };
  await cdp.detach();
  page = await browser.newPage({ viewport: CANVAS, deviceScaleFactor: 1 });
  page.on('console', message => event({ kind: 'console', type: message.type(), text: message.text() }));
  page.on('pageerror', error => event({ kind: 'pageerror', text: String(error) }));
  page.on('crash', () => event({ kind: 'crash' }));
  await page.goto(row.origin, { waitUntil: 'load', timeout: 10000 });
  phase = 'graphics-control';
  row.context = await bounded(page.evaluate(canvasControl, { action: 'initialize' }), 10000);
  for (const color of COLORS) {
    const capture = { name: color.name, expectedRGBA: color.bytes,
      expectedARGB: ((color.bytes[3] << 24) | (color.bytes[0] << 16) | (color.bytes[1] << 8) | color.bytes[2]) >>> 0 }; row.colors.push(capture);
    capture.gpu = await bounded(page.evaluate(canvasControl, { action: 'clear', color: color.clear }), 5000);
    capture.gpu.rgba = rgba(capture.gpu.format, capture.gpu.rawCenter);
    capture.presentationFrames = await bounded(page.evaluate(canvasControl, { action: 'presentation-frames' }), 5000);
    const png = await page.screenshot({ path: join(directory, `${name}-${color.name}.png`), timeout: 5000 });
    capture.png = await bounded(page.evaluate(pngCenter, png.toString('base64')), 5000);
    capture.actualARGB = ((capture.png.center[3] << 24) | (capture.png.center[0] << 16) | (capture.png.center[1] << 8) | capture.png.center[2]) >>> 0;
    requirePixels(capture.gpu.rgba, color.bytes, `${color.name} GPU readback`);
    if (capture.png.width !== CANVAS.width || capture.png.height !== CANVAS.height) throw new Error('PNG canvas dimensions differ');
    requirePixels(capture.png.center, color.bytes, `${color.name} PNG presentation`);
  }
  row.observation = await bounded(page.evaluate(canvasControl, { action: 'observe' }), 16000);
  row.status = 'observed';
} catch (error) { row.status = 'refused'; row.reason = String(error); }
finally {
  phase = 'pre-teardown';
  try {
    if (page && !page.isClosed()) await page.screenshot({ path: join(directory, `${name}-terminal.png`), timeout: 3000 });
    save();
  } catch (error) { row.status = 'refused'; row.evidenceWriteError = String(error); }
  phase = 'teardown';
  const deadline = Date.now() + 30000;
  try {
    const closes = [];
    if (browser) closes.push(browser.close());
    if (server) { server.closeAllConnections(); closes.push(new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))); }
    await bounded(Promise.all(closes), Math.max(1, deadline - Date.now()));
    row.teardown = 'complete';
  } catch (error) { row.status = 'refused'; row.teardown = 'refused'; row.teardownError = String(error); }
  row.endedUTC = new Date().toISOString();
  row.eventBytes = eventBytes;
  if (row.diagnosticRefusal) { row.status = 'refused'; row.reason ??= row.diagnosticRefusal; }
  try { save(); } catch (error) { console.error('Result write failed', error); process.exitCode = 1; }
  if (row.status !== 'observed' || row.teardown !== 'complete') process.exitCode = 1;
}
