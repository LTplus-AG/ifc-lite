#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Retained BROWSER memory (#7955 item 6, the #7955 qualification plan, "Browser"): one fresh
// Chrome process and page per sample runs one model through the real
// `RetainedModelSession` over the staged, inventory-validated engine (the same serving
// as scripts/retained-compare/browser.mjs). Reported per sample: retained WASM linear
// memory (start / maximum observed / end), `measureUserAgentSpecificMemory`
// (worker-inclusive, before and after), `performance.memory`, and the Chrome process
// tree's peak VmHWM / concurrent RSS / PSS. The SDK's private Worker heap is reported
// null with its reason, never estimated; source-buffer duplication is not observable
// from the page and is reported as such. A session that does not publish retained
// products, or whose served manifest is not the staged one, FAILS.
//
//   node scripts/perf/retained-qual-browser-memory.mjs --out DIR --rounds 7 \
//     --arm branch:/abs/checkout:/abs/engine [--arm base:...] --fixture /abs/model.ifc [...]
//     [--expect pins.json] [--require-ua-memory] [--headed] [--gpu swiftshader|hardware]

import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { isMainEntry } from '../lib/is-main-entry.mjs';
import { engineIdentity, gitIdentity, parseArgs, parseArms, pinFor, resultEnvelope, roundSides, sha256File, summarizeRows,
  unreleasedQuietWindows, writeResult } from './retained-qual-lib.mjs';
import { startSampler } from './retained-qual-proc.mjs';
import { assertBrowserSession } from './retained-qual-assert.mjs';
import { launchFresh, raceWithTimeout } from './retained-qual-browser.mjs';

const COLUMNS = ['importMs', 'runMs', 'wasmHeapMaxObservedBytes', 'uaAfterBytes', 'browserPeakHwmKiB', 'browserPeakConcurrentPssKiB'];

export async function browserMemorySample({ arm, fixture, round, options, expectation }) {
  const row = { side: arm.side, path: fixture.path, fixture: basename(fixture.path), round, ok: false, fixtureSha256: fixture.sha256, fixtureBytes: fixture.bytes };
  const temporary = mkdtempSync(join(tmpdir(), 'retained-qual-bm-'));
  let server, browser, sampler;
  try {
    writeFileSync(join(temporary, 'index.html'), '<!doctype html><title>Retained browser memory</title>');
    const engine = arm.identity.engine.directory;
    const { serveRoots } = await import('../smlib-browser-worker-probe.mjs');
    server = serveRoots({ '/smlib/': join(engine, 'smlib'), '/pkg/': join(engine, 'pkg-retained'), '/harness/': import.meta.dirname,
      '/model/': dirname(fixture.path), '/engine/': engine, '/page/': temporary });
    server.prependListener('request', (_request, response) => {
      response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    });
    await new Promise(done => server.listen(0, '127.0.0.1', done));
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await launchFresh({ gpu: options.gpu ?? 'swiftshader', channel: options.channel ?? 'chrome', executable: options['browser-executable'], headed: Boolean(options.headed) });
    const { page } = browser;
    await page.goto(`${origin}/page/index.html`);
    row.userAgent = await page.evaluate(() => navigator.userAgent);
    await page.evaluate(async () => {
      window.harness = await import('/harness/retained-qual-browser-memory-page.mjs');
      await window.harness.initialize();
    });
    sampler = startSampler(null, { intervalMs: 100, profileDir: browser.profileDir, pss: true });
    const run = await raceWithTimeout(page.evaluate(url => window.harness.runModel(url), `/model/${encodeURIComponent(basename(fixture.path))}`),
      Number(options['timeout-ms'] ?? 900000), 'retained session');
    const tree = sampler.stop(); sampler = null;
    const served = await (await fetch(`${origin}/engine/engine-manifest.json`)).arrayBuffer();
    const servedManifestSha256 = createHash('sha256').update(Buffer.from(served)).digest('hex');
    Object.assign(row, { importMs: run.importMs, runMs: run.runMs, sourceBytes: run.sourceBytes, wasmHeapStartBytes: run.wasmHeapStartBytes,
      wasmHeapMaxObservedBytes: run.wasmHeapMaxObservedBytes, wasmHeapEndBytes: run.wasmHeapEndBytes,
      wasmHeapNote: 'retained pkg linear memory observed at module load, each product event and the end: a maximum OBSERVED, not an allocation-exact peak',
      uaBefore: run.uaBefore, uaAfter: run.uaAfter, uaAfterBytes: run.uaAfter.bytes, jsHeapBefore: run.jsBefore, jsHeapAfter: run.jsAfter,
      smlibHeapBytes: null, smlibHeapReason: 'SDK linear heap is private to its module Worker; browser memory and process-tree figures include Workers when supported',
      sourceBufferDuplication: null, sourceBufferDuplicationReason: 'not exposed to the page; the SDK Worker holds its own copy privately',
      browserPeakHwmKiB: tree.maxIndividualHwmKiB, browserPeakConcurrentRssKiB: tree.maxObservedConcurrentRssKiB,
      browserPeakConcurrentPssKiB: tree.maxObservedConcurrentPssKiB, browserProcesses: Object.values(tree.byPid).map(p => ({ type: p.type ?? 'browser', hwmKiB: p.hwmKiB, peakPssKiB: p.peakPssKiB })),
      browserMemorySamples: tree.samples, pssCoverage: tree.pssCoverage, browserMemoryCaveat: tree.caveat, sessionSummary: run.summary, pageErrors: browser.pageErrors });
    if (options['require-ua-memory'] && (run.uaAfter.bytes === null || run.uaBefore.bytes === null)) {
      throw new Error(`measureUserAgentSpecificMemory unavailable: ${run.uaAfter.reason ?? run.uaBefore.reason}`);
    }
    assertBrowserSession({ run, expectation, servedManifestSha256, expectedManifestSha256: arm.identity.engine.manifestSha256 });
    Object.assign(row, { ok: true, candidates: run.summary.candidates, published: run.summary.published, refused: run.summary.refused,
      meshes: run.tally.meshes, restarts: run.summary.restarts });
  } catch (error) {
    row.cleanupFailed = error?.cleanupFailed === true;
    row.error = error instanceof Error ? error.message : String(error);
  } finally {
    sampler?.stop();
    const closeError = browser ? await browser.close() : null;
    if (closeError) { row.cleanupFailed = true; row.ok = false; row.error = `${row.error ?? 'ok'}; browser cleanup failed: ${closeError}`; }
    if (server) await new Promise(done => server.close(done));
    rmSync(temporary, { recursive: true, force: true });
  }
  return row;
}

export async function main(argv) {
  const { options } = parseArgs(argv, { values: ['out', 'rounds', 'seed', 'timeout-ms', 'gpu', 'channel', 'browser-executable', 'expect', 'exclusive-receipt'],
    repeated: ['arm', 'fixture'], flags: ['headed', 'require-ua-memory', 'require-quiet'] });
  if (options.seed !== undefined && !Number.isFinite(Number(options.seed))) throw new Error('--seed must be finite');
  if (!options.out || !options.fixture.length) throw new Error('--out DIR and at least one --fixture are required');
  if (options['require-quiet'] && unreleasedQuietWindows().length) throw new Error(`Unreleased quiet window blocks Pop work: ${unreleasedQuietWindows().join(', ')}`);
  const rounds = Number(options.rounds ?? 7);
  if (!Number.isInteger(rounds) || rounds < 1) throw new Error('--rounds must be a positive integer');
  const arms = parseArms(options.arm);
  const expectations = options.expect ? JSON.parse(readFileSync(options.expect, 'utf8')) : {};
  for (const arm of arms) arm.identity = { git: gitIdentity(arm.checkout), engine: await engineIdentity(arm.checkout, arm.engine) };
  const fixtures = [];
  for (const path of options.fixture.map(f => resolve(f))) fixtures.push({ path, bytes: statSync(path).size, sha256: await sha256File(path) });
  const started = Date.now(), out = resolve(options.out);
  mkdirSync(out, { recursive: true });
  const result = resultEnvelope({ kind: 'browser-retained-memory', options, arms, identities: arms.map(a => a.identity), fixtures, started });
  const order = await roundSides(arms, rounds, options.seed === undefined ? undefined : Number(options.seed));
  result.order = order;
  const rows = [];
  samples: for (let round = 1; round <= rounds; round++) for (const side of order[round - 1]) for (const fixture of fixtures) {
    console.log(`retained-qual-browser-memory: ${side} ${basename(fixture.path)} round ${round}/${rounds}`);
    const row = await browserMemorySample({ arm: arms.find(a => a.side === side), fixture, round, options, expectation: pinFor(expectations, side, basename(fixture.path)) });
    rows.push(row);
    appendFileSync(join(out, 'runs.partial.jsonl'), JSON.stringify(row) + '\n');
      if (row.cleanupFailed) break samples;
    console.log(row.ok ? `  ok wasm max ${row.wasmHeapMaxObservedBytes} B, browser peak HWM ${row.browserPeakHwmKiB} KiB, published ${row.published}/${row.candidates}` : `  FAILED ${row.error}`);
  }
  Object.assign(result, { finishedAt: new Date().toISOString(), rounds, samples: rows.filter(r => r.ok).length, rows: rows.length,
    failures: rows.filter(r => !r.ok).map(r => ({ side: r.side, path: r.path, round: r.round, error: r.error })), summary: summarizeRows(rows, COLUMNS) });
  writeResult(out, result, rows);
  console.log(`retained-qual-browser-memory: ${result.samples}/${rows.length} samples ok; ${out}/result.json`);
  return result.failures.length ? 1 : 0;
}

if (isMainEntry(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
