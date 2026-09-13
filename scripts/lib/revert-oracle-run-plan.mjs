/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseRunnerOutput } from './revert-oracle.mjs';
import { runTypecheckPlan } from './revert-oracle-type-only.mjs';

const toolchainVersions = new Map();
const RUN_TIMEOUT_MS = 10 * 60 * 1000;

/** Resolve a runner binary the way the owning package would. */
function resolveCommand(bin, pkgDir, root) {
  if (bin === 'node') return { bin: process.execPath, prefix: [] };
  if (bin === 'python3' && process.platform === 'win32') return { bin: 'py', prefix: ['-3'] };
  if (bin === 'cargo' || bin === 'python3') return { bin, prefix: [] };
  let dir = pkgDir;
  for (;;) {
    const manifest = join(dir, 'node_modules', bin, 'package.json');
    if (existsSync(manifest)) {
      try {
        const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
        const target = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.[bin];
        if (typeof target === 'string') return { bin: process.execPath, prefix: [join(dirname(manifest), target)] };
      } catch (error) {
        throw new Error(`cannot resolve ${bin} from ${manifest}: ${error.message}`);
      }
    }
    const candidate = join(dir, 'node_modules', '.bin', bin);
    if (process.platform !== 'win32' && existsSync(candidate)) return { bin: candidate, prefix: [] };
    const parent = dirname(dir);
    if (parent === dir || !parent.startsWith(root)) return null;
    dir = parent;
  }
}

function logRun(plan, root, label, parsed, exit, log) {
  log(
    `  [${label}] ${relative(root, plan.dir) || '.'} (${plan.runner.family}) -> ${parsed.kind}` +
      ` (pass ${parsed.passed ?? '?'}, fail ${parsed.failed ?? '?'}, total ${parsed.total ?? '?'}, exit ${exit}, ${parsed.durationMs}ms)`,
  );
}

function toolchainIdentity(binPath, family) {
  const key = `${family}:${binPath}`;
  if (toolchainVersions.has(key)) return toolchainVersions.get(key);
  const identity = family === 'node-test' || family === 'typecheck'
    ? `node ${process.version}`
    : (() => {
        const version = spawnSync(binPath, ['--version'], { encoding: 'utf8' });
        return version.status === 0 ? `${version.stdout ?? version.stderr}`.trim() : `${family} (version unavailable)`;
      })();
  toolchainVersions.set(key, identity);
  return identity;
}

export function runPlan(plan, root, label, log = console.log) {
  const started = Date.now();
  if (plan.typecheck) {
    const parsed = runTypecheckPlan(plan, root, label);
    parsed.durationMs = Date.now() - started;
    parsed.tail = parsed.evidence.join('\n');
    parsed.rawExitCode ??= null;
    parsed.signal = null;
    parsed.toolchain = `node ${process.version}`;
    parsed.attributed = parsed.attributed === true;
    logRun(plan, root, label, parsed, parsed.kind === 'runner-missing' ? '?' : parsed.kind === 'pass' ? 0 : 1, log);
    return parsed;
  }
  const cwd = plan.crate ? root : plan.dir;
  const command = resolveCommand(plan.runner.bin, plan.dir, root);
  if (!command) {
    return {
      kind: 'runner-missing',
      passed: null,
      failed: null,
      total: null,
      evidence: [`runner binary "${plan.runner.bin}" not found from ${relative(root, plan.dir) || '.'} — run pnpm install`],
      rawExitCode: null,
      signal: null,
      toolchain: null,
    };
  }
  const recordsExecution = plan.runner.family === 'node-test';
  const coverageDir = recordsExecution ? mkdtempSync(join(tmpdir(), 'revert-oracle-execution-')) : null;
  const spawnOptions = {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: RUN_TIMEOUT_MS,
    env: { ...process.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1', ...(coverageDir ? { NODE_V8_COVERAGE: coverageDir } : {}) },
  };
  let run;
  let executionFiles = [];
  let executionEvidenceError = null;
  try {
    if (plan.runner.family === 'vitest') {
      const selected = plan.relFiles?.[0] ?? plan.file;
      const listed = spawnSync(command.bin, [...command.prefix, 'list', selected, '--filesOnly'], spawnOptions);
      if (listed.error || listed.status !== 0 || listed.signal) {
        throw listed.error ?? new Error(`vitest file discovery failed (${listed.signal ?? listed.status})`);
      }
      executionFiles = `${listed.stdout ?? ''}\n${listed.stderr ?? ''}`.split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(line))
        .map((line) => resolve(plan.dir, line));
    }
    run = plan.moduleFilter
      ? runExactCargoModule(command.bin, [...command.prefix, ...plan.runner.args], plan.moduleFilter, spawnOptions)
      : spawnSync(command.bin, [...command.prefix, ...plan.runner.args], spawnOptions);
    if (coverageDir) executionFiles = readCoveredFiles(coverageDir);
  } catch (error) {
    executionEvidenceError = error instanceof Error ? error.message : String(error);
  } finally {
    if (coverageDir) rmSync(coverageDir, { recursive: true, force: true });
  }
  if (!run) throw new Error(`runner did not produce a process result: ${executionEvidenceError ?? 'unknown error'}`);
  const parsed = parseRunnerOutput({
    family: plan.runner.family,
    stdout: run.stdout ?? '',
    stderr: run.stderr ?? '',
    exitCode: run.status,
    signal: run.signal ?? null,
    spawnError: run.error ? run.error.message : undefined,
  });
  if (
    plan.moduleFilter &&
    (parsed.kind === 'pass' || parsed.kind === 'assertion-failure') &&
    (!Array.isArray(parsed.identities) || parsed.identities.length === 0 || parsed.identities.some((name) => !name.startsWith(`${plan.moduleFilter}::`)))
  ) {
    parsed.kind = 'unparseable';
    parsed.evidence = [`cargo's ${plan.moduleFilter}:: filter also selected tests outside that source module`];
  }
  parsed.rawExitCode = run.status;
  parsed.signal = run.signal ?? null;
  parsed.toolchain = toolchainIdentity(command.bin, plan.runner.family);
  parsed.executionFiles = executionFiles;
  parsed.attributed = executionEvidenceError === null && attributableExecution(plan, parsed);
  if (executionEvidenceError) parsed.evidence.push(`could not read runtime execution evidence: ${executionEvidenceError}`);
  parsed.durationMs = Date.now() - started;
  parsed.tail = `${run.stdout ?? ''}\n${run.stderr ?? ''}`.trim().split('\n').slice(-25).join('\n');
  logRun(plan, root, label, parsed, run.status, log);
  return parsed;
}

function readCoveredFiles(dir) {
  const files = new Set();
  for (const entry of readdirSync(dir).filter((name) => name.endsWith('.json'))) {
    const report = JSON.parse(readFileSync(join(dir, entry), 'utf8'));
    if (!Array.isArray(report.result)) throw new Error(`${entry} has no V8 coverage result array`);
    for (const script of report.result) {
      if (typeof script?.url !== 'string' || !script.url.startsWith('file:')) continue;
      files.add(resolve(fileURLToPath(script.url)));
    }
  }
  return [...files];
}

function runExactCargoModule(binPath, args, moduleFilter, options) {
  const separator = args.indexOf('--');
  const cargoArgs = separator === -1 ? args : args.slice(0, separator);
  const listed = spawnSync(binPath, [...cargoArgs, '--', '--list'], options);
  if (listed.error || listed.status !== 0 || listed.signal) return listed;
  const identities = `${listed.stdout ?? ''}\n${listed.stderr ?? ''}`
    .split(/\r?\n/)
    .map((line) => /^(.+): test$/.exec(line)?.[1])
    .filter((identity) => identity && identity.startsWith(`${moduleFilter}::`));
  if (identities.length === 0) {
    return { status: 0, signal: null, stdout: 'test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\n', stderr: '' };
  }
  const runs = identities.map((identity) => spawnSync(binPath, [...cargoArgs, '--', identity, '--exact'], options));
  const failed = runs.find((candidate) => candidate.error || candidate.signal || candidate.status !== 0);
  return {
    status: failed?.status ?? 0,
    signal: failed?.signal ?? null,
    error: failed?.error,
    stdout: runs.map((candidate) => candidate.stdout ?? '').join('\n'),
    stderr: runs.map((candidate) => candidate.stderr ?? '').join('\n'),
  };
}

function attributableExecution(plan, parsed) {
  if (!Number.isInteger(parsed.total) || parsed.total <= 0) return false;
  if (plan.moduleFilter) {
    return Array.isArray(parsed.identities) && parsed.identities.length > 0
      && parsed.identities.every((name) => name.startsWith(`${plan.moduleFilter}::`));
  }
  if (plan.crate) {
    return Boolean(plan.integrationTarget) && Array.isArray(parsed.identities) && parsed.identities.length > 0;
  }
  const selected = plan.relFiles?.[0] ?? plan.file;
  if (plan.runner.family === 'python') {
    return plan.files?.length === 1 && plan.runner.args.some((arg) => arg === selected || arg === plan.file);
  }
  const expected = resolve(plan.dir, selected);
  const samePath = (candidate) => process.platform === 'win32'
    ? candidate.toLowerCase() === expected.toLowerCase()
    : candidate === expected;
  if (plan.runner.family === 'vitest') {
    return plan.files?.length === 1 && parsed.executionFiles?.length === 1 && samePath(parsed.executionFiles[0]);
  }
  return plan.files?.length === 1 && parsed.executionFiles?.some(samePath);
}
