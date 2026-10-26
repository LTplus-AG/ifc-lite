/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Guarded root test launcher. Integration: "test": "node scripts/test-cache.mjs".
 * Direct `turbo test` deliberately remains uncached. Never write turbo.json at
 * runtime: concurrent root commands must keep their own configuration.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, availableParallelism, release } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isMainEntry } from './lib/is-main-entry.mjs';

// Audited local invariants only. These have no workspace runtime dependencies,
// model fixtures, GPU, network, real WASM, or enabled Vitest typecheck. Adding a
// suite requires an input/side-effect audit; plugin-api's typecheck is deferred.
export const CACHE_SUITES = ['embed-protocol', 'report-contract', 'wasm-lifecycle'];
const IDENTITY_ENV = 'IFC_LITE_TEST_CACHE_IDENTITY';
const digest = (value) => createHash('sha256').update(value).digest('hex');

export function cachePlan(root, args, env = process.env, runtime = process) {
  const config = JSON.parse(readFileSync(join(root, 'turbo.json'), 'utf8'));
  const ua = env.npm_config_user_agent;
  const identity = `node/${runtime.version} ${runtime.platform} ${runtime.arch}`;
  // Flags can import code/config outside declared inputs. Preserve their full
  // functionality by running uncached, rather than pretending the strings hash
  // the referenced files. Unknown Turbo options likewise fail closed.
  const safeArgs = args.every((arg) => /^(--(?:filter|concurrency|cache-dir|cache|output-logs|log-order|log-prefix)=.+|--(?:dry-run(?:=json)?|summarize|force|no-cache|no-daemon|continue(?:=.+)?))$/.test(arg));
  const eligible = typeof ua === 'string' && /^pnpm\/\d+\.\d+\.\d+ /.test(ua)
    && ua.endsWith(identity) && !env.NODE_OPTIONS && !env.NODE_PATH && runtime.execArgv.length === 0
    && safeArgs && env.TURBO_ENV_MODE !== 'loose';
  if (!eligible) return { config, env, eligible: false };

  // Hash every inherited environment value, including global passthrough env,
  // PATH, locale, timezone, runner selectors, and Node/pnpm settings. Only the
  // digest is passed to Turbo; no secret values are printed or persisted here.
  const inherited = Object.entries(env).filter(([key]) => key !== IDENTITY_ENV)
    .sort(([a], [b]) => a.localeCompare(b));
  const fingerprint = digest(JSON.stringify({
    protocol: 1, versions: runtime.versions, platform: runtime.platform,
    arch: runtime.arch, execPath: runtime.execPath, execArgv: runtime.execArgv,
    nodeBinary: digest(readFileSync(runtime.execPath)),
    // Eligible CLI flags only control Turbo orchestration/cache reporting.
    // Keeping them out lets dry-run predict execution, and filtered/full runs
    // share a result. Runner flags (after --) currently force uncached execution.
    osRelease: release(), parallelism: availableParallelism(), runnerFlags: [], inherited,
  }));
  for (const suite of CACHE_SUITES) {
    const name = `@ifc-lite/${suite}`;
    const pkg = JSON.parse(readFileSync(join(root, 'packages', suite, 'package.json'), 'utf8'));
    // A new workspace/runtime dependency or runner contract needs a fresh audit.
    if (pkg.name !== name || pkg.scripts.test !== 'vitest run'
      || Object.keys(pkg.dependencies ?? {}).length
      || Object.keys(pkg.optionalDependencies ?? {}).length
      || Object.keys(pkg.peerDependencies ?? {}).length
      || Object.values(pkg.devDependencies ?? {}).some((v) => v.startsWith('workspace:'))) continue;
    if (config.tasks[`${name}#test`]) continue;
    config.tasks[`${name}#test`] = {
      ...config.tasks.test,
      cache: true,
      outputs: [],
      inputs: ['$TURBO_DEFAULT$', 'src/**', 'test/**', 'tests/**', '*.json', '*config.*', '.env*',
        '$TURBO_ROOT$/scripts/test-cache.mjs'],
      env: [...(config.tasks.test.env ?? []), IDENTITY_ENV],
    };
  }
  return { config, env: { ...env, [IDENTITY_ENV]: fingerprint }, eligible: true };
}

export async function runTests(root, args) {
  const plan = cachePlan(root, args);
  const scratch = mkdtempSync(join(tmpdir(), 'ifc-test-cache-'));
  const configPath = join(scratch, 'turbo.json');
  try {
    writeFileSync(configPath, JSON.stringify(plan.config));
    // Resolve the repo's pinned Turbo, without shell quoting or a global binary.
    const require = createRequire(join(root, 'package.json'));
    const turbo = require.resolve('turbo/bin/turbo');
    return await new Promise((accept, reject) => {
      const child = spawn(process.execPath,
        [turbo, 'test', `--root-turbo-json=${configPath}`, ...args],
        { cwd: root, env: plan.env, stdio: 'inherit' });
      const forward = (signal) => child.kill(signal);
      // Turbo's JS shim consumes PID-directed SIGINT without forwarding it
      // on POSIX. Its SIGTERM path reaches native Turbo, which stops tasks.
      let interrupted = false;
      const onInterrupt = () => { interrupted = true; forward('SIGTERM'); };
      const onTerminate = () => forward('SIGTERM');
      process.on('SIGINT', onInterrupt);
      process.on('SIGTERM', onTerminate);
      const cleanup = () => {
        process.off('SIGINT', onInterrupt);
        process.off('SIGTERM', onTerminate);
      };
      child.once('error', (error) => { cleanup(); reject(error); });
      child.once('exit', (code, signal) => {
        cleanup();
        accept(interrupted ? 130 : (code ?? (signal === 'SIGINT' ? 130 : 143)));
      });
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (isMainEntry(import.meta.url)) {
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  process.exitCode = await runTests(root, process.argv.slice(2));
}
