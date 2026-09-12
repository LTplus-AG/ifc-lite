/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

import { parseRunnerOutput } from './revert-oracle.mjs';
import { runTypecheckPlan } from './revert-oracle-type-only.mjs';

/** Resolve a runner binary the way the owning package would. */
function resolveBin(bin, pkgDir, root) {
  if (bin === 'node') return process.execPath;
  if (bin === 'cargo' || bin === 'python3') return bin;
  let dir = pkgDir;
  for (;;) {
    const candidate = join(dir, 'node_modules', '.bin', bin);
    if (existsSync(candidate)) return candidate;
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

export function runPlan(plan, root, label, log = console.log) {
  const started = Date.now();
  if (plan.typecheck) {
    const parsed = runTypecheckPlan(plan, root, label);
    parsed.durationMs = Date.now() - started;
    parsed.tail = parsed.evidence.join('\n');
    logRun(plan, root, label, parsed, parsed.kind === 'runner-missing' ? '?' : parsed.kind === 'pass' ? 0 : 1, log);
    return parsed;
  }
  const cwd = plan.crate ? root : plan.dir;
  const binPath = resolveBin(plan.runner.bin, plan.dir, root);
  if (!binPath) {
    return {
      kind: 'runner-missing',
      passed: null,
      failed: null,
      total: null,
      evidence: [`runner binary "${plan.runner.bin}" not found from ${relative(root, plan.dir) || '.'} — run pnpm install`],
    };
  }
  const run = spawnSync(binPath, plan.runner.args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' },
  });
  const parsed = parseRunnerOutput({
    family: plan.runner.family,
    stdout: run.stdout ?? '',
    stderr: run.stderr ?? '',
    exitCode: run.status,
    spawnError: run.error ? run.error.message : undefined,
  });
  parsed.rawExitCode = run.status;
  parsed.durationMs = Date.now() - started;
  parsed.tail = `${run.stdout ?? ''}\n${run.stderr ?? ''}`.trim().split('\n').slice(-25).join('\n');
  logRun(plan, root, label, parsed, run.status, log);
  return parsed;
}
