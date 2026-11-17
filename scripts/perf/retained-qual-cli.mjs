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

import { closeSync, createReadStream, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, statSync, appendFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { constants, tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { isMainEntry } from '../lib/is-main-entry.mjs';
import { assertPinCoverage, engineIdentity, gitIdentity, parseArgs, parseArms, pinFor, resultEnvelope, resetPartial, roundSides, sha256File, summarizeRows,
  unreleasedQuietWindows, writeResult } from './retained-qual-lib.mjs';
import { sampleTimeout, STDERR_TAIL_BYTES, waitForProcess } from './retained-qual-process.mjs';
import { startSampler } from './retained-qual-proc.mjs';
import { assertCliRetained } from './retained-qual-assert.mjs';

const COLUMNS = ['totalMs', 'startupControlMs', 'maxRssKiB', 'processHwmKiB'];
const TIME = existsSync('/usr/bin/time') ? '/usr/bin/time' : null;

function head(path, bytes = 4096) {
  const fd = openSync(path, 'r'), buffer = Buffer.alloc(bytes);
  try { return buffer.subarray(0, readSync(fd, buffer, 0, bytes, 0)).toString('utf8'); } finally { closeSync(fd); }
}

/**
 * The report without its product rows, each row parsed and counted against the summary.
 * A whole-model report can exceed the maximum string length (#7955 Holter), so it is read
 * a product at a time; the writer puts every row between fixed two- and four-space lines.
 */
export async function readReportEnvelope(path) {
  const outer = [];
  let row = null, inProducts = false, total = 0, published = 0;
  for await (const line of createInterface({ input: createReadStream(path), crlfDelay: Infinity })) {
    if (row) {
      row.push(line);
      if (line !== '    }' && line !== '    },') continue;
      if (JSON.parse(row.join('\n').replace(/,$/, '')).status === 'published') published++;
      total++;
      row = null;
    } else if (inProducts) {
      if (line === '    {') row = [line];
      else if (line === '  ],') inProducts = false;
      else throw new Error(`malformed retained report row: ${line.slice(0, 80)}`);
    } else if (line === '  "products": [') inProducts = true;
    else outer.push(line);
  }
  if (row || inProducts) throw new Error('truncated retained report');
  const envelope = JSON.parse(outer.join('\n'));
  if (total !== envelope.summary?.candidates || published !== envelope.summary?.published) {
    throw new Error(`retained report rows ${published}/${total} != summary ${envelope.summary?.published}/${envelope.summary?.candidates}`);
  }
  return envelope;
}

/** Run one command to completion under /usr/bin/time -v with the process-tree sampler; times with hrtime. */
async function timedRun(argv, cwd, scratch, name, timeoutMs) {
  const timeFile = join(scratch, `${name}.time`);
  const command = TIME ? [TIME, '-v', '-o', timeFile, ...argv] : argv;
  const started = process.hrtime.bigint();
  const child = spawn(command[0], command.slice(1), { cwd, detached: true,
    env: { ...process.env, LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const completion = waitForProcess(child, timeoutMs);
  let stdout = '', stderr = Buffer.alloc(0);
  // Only emptiness matters for stdout; retain bounded diagnostics for stderr.
  child.stdout?.on('data', c => { if (c.length) stdout = 'non-empty stdout'; });
  child.stderr?.on('data', c => { stderr = Buffer.concat([stderr, c]).subarray(-STDERR_TAIL_BYTES); });
  const sampler = startSampler(child.pid, { intervalMs: 50 });
  const { code, signal, timedOut, spawnError } = await completion;
  const memory = sampler.stop();
  const totalMs = Number(process.hrtime.bigint() - started) / 1e6;
  let maxRssKiB = null, timeDiagnostic = null, terminationSignal = signal;
  if (TIME && existsSync(timeFile)) {
    const timeReport = readFileSync(timeFile, 'utf8');
    maxRssKiB = Number(timeReport.match(/Maximum resident set size \(kbytes\): (\d+)/)?.[1] ?? NaN);
    timeDiagnostic = timeReport.match(/^Command (?:terminated by signal|exited with non-zero status) .+$/m)?.[0] ?? null;
    const signalNumber = Number(timeReport.match(/^Command terminated by signal (\d+)$/m)?.[1]);
    terminationSignal ??= Object.entries(constants.signals).find(([, value]) => value === signalNumber)?.[0] ?? null;
  }
  return { exitCode: signal ? -1 : code, signal, timedOut, spawnError, stdout, stderr: stderr.toString('utf8'), totalMs, memory,
    processStatus: { stage: name, pid: child.pid ?? null, executable: command[0], timeWrapped: !!TIME,
      exitCode: code, signal, terminationSignal, timeDiagnostic },
    maxRssKiB: Number.isFinite(maxRssKiB) ? maxRssKiB : null };
}

export async function cliSample({ arm, fixture, round, options, expectation }) {
  const scratch = mkdtempSync(join(tmpdir(), 'retained-qual-cli-'));
  const cli = join(arm.checkout, 'packages/cli/dist/index.js');
  const row = { side: arm.side, path: fixture.path, fixture: basename(fixture.path), round, ok: false, fixtureSha256: fixture.sha256, fixtureBytes: fixture.bytes,
    node: process.version };
  try {
    const timeoutMs = sampleTimeout(options['timeout-ms']);
    row.timeoutMs = timeoutMs;
    const deadline = performance.now() + timeoutMs;
    const checkRun = run => {
      // GNU time returns 128+signal with a normal wrapper exit. Preserve its
      // diagnosis before scratch cleanup; 139 alone is not evidence of SIGSEGV (#8868).
      (row.processes ??= []).push(run.processStatus);
      row.stderrTail = run.stderr;
      if (run.spawnError) row.processError = run.spawnError.message;
      if (run.timedOut) throw new Error('timeout');
      if (run.spawnError) throw run.spawnError;
      if (run.exitCode !== 0) throw new Error(`CLI failed (${run.exitCode}): ${run.stderr}`);
    };
    const control = await timedRun([process.execPath, cli, '--version'], arm.checkout, scratch, 'control', deadline - performance.now());
    checkRun(control);
    const obj = join(scratch, 'model.obj'), reportPath = join(scratch, 'report.json');
    const run = await timedRun([process.execPath, cli, 'export', fixture.path, '--format', 'obj', '--kernel', 'retained',
      '--retained-engine', arm.engine, '--retained-report', reportPath, '--out', obj], arm.checkout, scratch, 'export', deadline - performance.now());
    Object.assign(row, { totalMs: run.totalMs, startupControlMs: control.totalMs, maxRssKiB: run.maxRssKiB,
      processHwmKiB: run.memory.maxIndividualHwmKiB, concurrentRssKiB: run.memory.maxObservedConcurrentRssKiB, memorySamples: run.memory.samples,
      memoryCaveat: `Node CLI process tree (own WASM/worker transport), not native SMLib worker RSS; ${run.memory.caveat}` });
    checkRun(run);
    const report = existsSync(reportPath) ? await readReportEnvelope(reportPath) : null;
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
  const { options } = parseArgs(argv, { values: ['out', 'rounds', 'seed', 'timeout-ms', 'expect', 'exclusive-receipt'], repeated: ['arm', 'fixture'], flags: ['require-quiet'] });
  sampleTimeout(options['timeout-ms']);
  if (options.seed !== undefined && !Number.isFinite(Number(options.seed))) throw new Error('--seed must be finite');
  if (!options.out || !options.fixture.length) throw new Error('--out DIR and at least one --fixture are required');
  if (options['require-quiet'] && unreleasedQuietWindows().length) throw new Error(`Unreleased quiet window blocks Pop work: ${unreleasedQuietWindows().join(', ')}`);
  const rounds = Number(options.rounds ?? 7);
  if (!Number.isInteger(rounds) || rounds < 1) throw new Error('--rounds must be a positive integer');
  const arms = parseArms(options.arm);
  const expectations = options.expect ? JSON.parse(readFileSync(options.expect, 'utf8')) : {};
  if (options.expect !== undefined) assertPinCoverage(expectations, arms, options.fixture.map(path => ({ path: resolve(path) })));
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
  resetPartial(out);
  for (let round = 1; round <= rounds; round++) for (const side of order[round - 1]) for (const fixture of fixtures) {
    console.log(`retained-qual-cli: ${side} ${basename(fixture.path)} round ${round}/${rounds}`);
    const row = await cliSample({ arm: arms.find(a => a.side === side), fixture, round, options, expectation: pinFor(expectations, side, fixture) });
    rows.push(row);
    appendFileSync(join(out, 'runs.partial.jsonl'), JSON.stringify(row) + '\n');
    console.log(row.ok ? `  ok ${row.totalMs.toFixed(0)} ms (control ${row.startupControlMs.toFixed(0)} ms), published ${row.published}/${row.candidates}` : `  FAILED ${row.error}`);
  }
  Object.assign(result, { finishedAt: new Date().toISOString(), rounds, samples: rows.filter(r => r.ok).length, rows: rows.length,
    failures: rows.filter(r => !r.ok).map(r => ({ side: r.side, path: r.path, round: r.round, error: r.error })), summary: summarizeRows(rows, COLUMNS) });
  writeResult(out, result, rows);
  console.log(`retained-qual-cli: ${result.samples}/${rows.length} samples ok; ${out}/result.json`);
  if (result.cohort?.complete === false) console.error(`incomplete cohort: expected ${result.cohort.expected}, got ${result.cohort.observed}`);
  return result.failures.length || result.cohort?.complete === false ? 1 : 0;
}

if (isMainEntry(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
