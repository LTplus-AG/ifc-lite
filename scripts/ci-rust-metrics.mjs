/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { constants } from 'node:os';
import { isMainEntry } from './lib/is-main-entry.mjs';

// #10279: artifact freshness is NOT the Actions archive hit rate. Keep both.
export async function measureCargo(label, args, env = process.env) {
  if (!label || !['test', 'clippy', 'command'].includes(args[0])) {
    throw new Error('Usage: node scripts/ci-rust-metrics.mjs LABEL test|clippy [cargo arguments], or LABEL command EXECUTABLE [arguments]');
  }
  if (args.includes('--no-run') || args.some(a => a.startsWith('--message-format'))) {
    throw new Error('The metrics runner owns --no-run and --message-format');
  }
  const recordPath = env.RUST_CI_METRICS || join(env.RUNNER_TEMP || '.', 'rust-ci-metrics.jsonl');
  const phase = async (name, command, json, executable = 'cargo') => {
    const start = performance.now();
    let fresh = 0, rebuilt = 0;
    const child = spawn(executable, command, { env, stdio: ['inherit', json ? 'pipe' : 'inherit', 'inherit'] });
    const forward = signal => child.kill(signal);
    const interrupt = () => forward('SIGINT');
    const terminate = () => forward('SIGTERM');
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', terminate);
    const lines = json ? createInterface({ input: child.stdout }) : null;
    lines?.on('line', line => {
      let message;
      try { message = JSON.parse(line); }
      catch { console.log(line); return; }
      if (message.reason === 'compiler-artifact') {
        if (message.fresh === true) fresh++;
        else rebuilt++;
      } else if (message.reason === 'compiler-message' && message.message?.rendered) {
        process.stderr.write(message.message.rendered);
      } else if (!['build-finished', 'build-script-executed'].includes(message.reason)) {
        console.log(line);
      }
    });
    const result = await new Promise(resolve => {
      child.once('error', error => resolve({ exitCode: 1, error: error.message }));
      child.once('close', (code, signal) => resolve({ exitCode: code ?? (signal ? 128 + constants.signals[signal] : 1), signal }));
    });
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
    const row = {
      schema: 1, sha: env.GITHUB_SHA || null, job: env.GITHUB_JOB || null,
      run: env.GITHUB_RUN_ID || null, attempt: env.GITHUB_RUN_ATTEMPT || null,
      label, phase: name, command: [executable, ...command],
      cache: env.RUST_CI_CACHE_HIT || 'unknown',
      seconds: (performance.now() - start) / 1000,
      ...(json ? { freshArtifacts: fresh, rebuiltArtifacts: rebuilt,
        artifactReuseRatio: fresh + rebuilt ? fresh / (fresh + rebuilt) : null } : {}),
      ...result,
    };
    appendFileSync(recordPath, `${JSON.stringify(row)}\n`);
    console.log(`Rust CI metrics: ${JSON.stringify(row)}`);
    if (env.GITHUB_STEP_SUMMARY) {
      appendFileSync(env.GITHUB_STEP_SUMMARY,
        `\n- ${label} / ${name}: ${row.seconds.toFixed(2)}s; exit ${row.exitCode}; archive=${row.cache}`
        + (json ? `; fresh artifacts=${fresh}; rebuilt=${rebuilt}` : '') + '\n');
    }
    return row.exitCode;
  };
  if (args[0] === 'command') {
    if (!args[1]) throw new Error('command requires an executable');
    return phase('command-total', args.slice(2), false, args[1]);
  }
  if (args[0] === 'clippy') {
    const separator = args.indexOf('--');
    const command = [...args];
    command.splice(separator < 0 ? command.length : separator, 0, '--message-format=json-render-diagnostics');
    return phase('clippy', command, true);
  }
  // Keep Cargo in charge of execution (including doctests, runners, filters,
  // --no-fail-fast and harness arguments). Never execute binaries ourselves.
  const separator = args.indexOf('--');
  const compile = [...args];
  compile.splice(separator < 0 ? compile.length : separator, 0, '--no-run', '--message-format=json-render-diagnostics');
  const code = await phase('compile', compile, true);
  if (code !== 0) return code;
  // Includes Cargo's warm freshness check and doctest compilation/execution;
  // it must not be presented as pure harness time or subtracted from a job.
  return phase('execute-with-cargo-and-doctests', args, false);
}

if (isMainEntry(import.meta.url)) {
  process.exitCode = await measureCargo(process.argv[2], process.argv.slice(3));
}
