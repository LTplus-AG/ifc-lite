#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Built Node `ifc-lite export --format obj --kernel retained` timing (#7955 item 6,
// the #7955 qualification plan, "Retained path"): one fresh process per sample from the
// checkout's `packages/cli/dist`, with the staged engine's inventory recorded.
// Node uses its own WASM/worker transport: the memory columns are the Node process
// tree (RSS/HWM), never the native SMLib worker's. Every sample is checked against its
// own retained report (kernel, engine manifest hash, published count) and OBJ header;
// an exact-kernel or refused run FAILS and is reported, never timed.
//
//   node scripts/perf/retained-qual-cli.mjs --out DIR --rounds 7 \
//     --arm branch:/abs/checkout:/abs/engine [--arm base:...] --fixture /abs/model.ifc [...]
//
// `startupControlMs` is `node dist/index.js --version` in the same round: process and
// module-load cost without any export. Report-only.

import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, statSync, appendFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { isMainEntry } from '../lib/is-main-entry.mjs';
import { engineIdentity, gitIdentity, parseArgs, parseArms, pinFor, resultEnvelope, roundSides, sha256File, summarizeRows,
  unreleasedQuietWindows, writeResult } from './retained-qual-lib.mjs';
import { startSampler } from './retained-qual-proc.mjs';
import { assertCliRetained } from './retained-qual-assert.mjs';

const COLUMNS = ['totalMs', 'startupControlMs', 'maxRssKiB', 'processHwmKiB'];
const TIME = existsSync('/usr/bin/time') ? '/usr/bin/time' : null;

function head(path, bytes = 4096) {
  const fd = openSync(path, 'r'), buffer = Buffer.alloc(bytes);
  try { return buffer.subarray(0, readSync(fd, buffer, 0, bytes, 0)).toString('utf8'); } finally { closeSync(fd); }
}

/** Run one command to completion under /usr/bin/time -v with the process-tree sampler; times with hrtime. */
function timedRun(argv, cwd, scratch, name) {
  return new Promise(resolveRun => {
    const timeFile = join(scratch, `${name}.time`);
    const command = TIME ? [TIME, '-v', '-o', timeFile, ...argv] : argv;
    const started = process.hrtime.bigint();
    const child = spawn(command[0], command.slice(1), { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', c => { stdout += c; });
    child.stderr.on('data', c => { stderr += c; });
    const sampler = startSampler(child.pid, { intervalMs: 50 });
    child.on('close', (exitCode, signal) => {
      const totalMs = Number(process.hrtime.bigint() - started) / 1e6;
      const memory = sampler.stop();
      let maxRssKiB = null;
      try { maxRssKiB = Number(readFileSync(timeFile, 'utf8').match(/Maximum resident set size \(kbytes\): (\d+)/)?.[1] ?? NaN); } catch { /* no /usr/bin/time */ }
      resolveRun({ exitCode: signal ? -1 : exitCode, signal, stdout, stderr, totalMs, memory, maxRssKiB: Number.isFinite(maxRssKiB) ? maxRssKiB : null });
    });
  });
}

export async function cliSample({ arm, fixture, round, options, expectation }) {
  const scratch = mkdtempSync(join(tmpdir(), 'retained-qual-cli-'));
  const cli = join(arm.checkout, 'packages/cli/dist/index.js');
  const row = { side: arm.side, path: fixture.path, fixture: basename(fixture.path), round, ok: false, fixtureSha256: fixture.sha256, fixtureBytes: fixture.bytes,
    node: process.version };
  try {
    const control = await timedRun([process.execPath, cli, '--version'], arm.checkout, scratch, 'control');
    if (control.exitCode !== 0) throw new Error(`CLI --version failed (${control.exitCode}): ${control.stderr.slice(0, 200)}`);
    const obj = join(scratch, 'model.obj'), reportPath = join(scratch, 'report.json');
    const run = await timedRun([process.execPath, cli, 'export', fixture.path, '--format', 'obj', '--kernel', 'retained',
      '--retained-engine', arm.engine, '--retained-report', reportPath, '--out', obj], arm.checkout, scratch, 'export');
    Object.assign(row, { totalMs: run.totalMs, startupControlMs: control.totalMs, maxRssKiB: run.maxRssKiB,
      processHwmKiB: run.memory.maxIndividualHwmKiB, concurrentRssKiB: run.memory.maxObservedConcurrentRssKiB, memorySamples: run.memory.samples,
      memoryCaveat: `Node CLI process tree (own WASM/worker transport), not native SMLib worker RSS; ${run.memory.caveat}` });
    const report = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) : null;
    assertCliRetained({ exitCode: run.exitCode, stdout: run.stdout, stderr: run.stderr, report, expectedManifestSha256: arm.identity.engine.manifestSha256,
      objHead: existsSync(obj) ? head(obj) : '', expectation });
    Object.assign(row, { ok: true, candidates: report.summary.candidates, published: report.summary.published,
      refused: report.summary.candidates - report.summary.published, byCode: report.summary.byCode, objBytes: statSync(obj).size,
      objSha256: await sha256File(obj), stderrSummary: run.stderr.trim().split('\n').pop() });
  } catch (error) {
    row.error = error instanceof Error ? error.message : String(error);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
  return row;
}

export async function main(argv) {
  const { options } = parseArgs(argv, { values: ['out', 'rounds', 'seed', 'expect', 'exclusive-receipt'], repeated: ['arm', 'fixture'], flags: ['require-quiet'] });
  if (!options.out || !options.fixture.length) throw new Error('--out DIR and at least one --fixture are required');
  if (options['require-quiet'] && unreleasedQuietWindows().length) throw new Error(`Unreleased quiet window blocks Pop work: ${unreleasedQuietWindows().join(', ')}`);
  const rounds = Number(options.rounds ?? 7);
  if (!Number.isInteger(rounds) || rounds < 1) throw new Error('--rounds must be a positive integer');
  const arms = parseArms(options.arm);
  const expectations = options.expect ? JSON.parse(readFileSync(options.expect, 'utf8')) : {};
  for (const arm of arms) {
    arm.identity = { git: gitIdentity(arm.checkout), engine: await engineIdentity(arm.checkout, arm.engine) };
    const cli = join(arm.checkout, 'packages/cli/dist/index.js');
    if (!existsSync(cli)) throw new Error(`CLI not built: ${cli}`);
    arm.cliSha256 = await sha256File(cli);
  }
  const fixtures = [];
  for (const path of options.fixture.map(f => resolve(f))) fixtures.push({ path, bytes: statSync(path).size, sha256: await sha256File(path) });
  const started = Date.now(), out = resolve(options.out);
  mkdirSync(out, { recursive: true });
  const result = resultEnvelope({ kind: 'cli-retained-export', options, arms, identities: arms.map(a => a.identity), fixtures, started });
  result.arms.forEach((entry, i) => { entry.cliEntrySha256 = arms[i].cliSha256; });
  const order = await roundSides(arms, rounds, options.seed === undefined ? undefined : Number(options.seed));
  result.order = order;
  const rows = [];
  for (let round = 1; round <= rounds; round++) for (const side of order[round - 1]) for (const fixture of fixtures) {
    console.log(`retained-qual-cli: ${side} ${basename(fixture.path)} round ${round}/${rounds}`);
    const row = await cliSample({ arm: arms.find(a => a.side === side), fixture, round, options, expectation: pinFor(expectations, side, basename(fixture.path)) });
    rows.push(row);
    appendFileSync(join(out, 'runs.partial.jsonl'), JSON.stringify(row) + '\n');
    console.log(row.ok ? `  ok ${row.totalMs.toFixed(0)} ms (control ${row.startupControlMs.toFixed(0)} ms), published ${row.published}/${row.candidates}` : `  FAILED ${row.error}`);
  }
  Object.assign(result, { finishedAt: new Date().toISOString(), rounds, samples: rows.filter(r => r.ok).length, rows: rows.length,
    failures: rows.filter(r => !r.ok).map(r => ({ side: r.side, path: r.path, round: r.round, error: r.error })), summary: summarizeRows(rows, COLUMNS) });
  writeResult(out, result, rows);
  console.log(`retained-qual-cli: ${result.samples}/${rows.length} samples ok; ${out}/result.json`);
  return result.failures.length ? 1 : 0;
}

if (isMainEntry(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
