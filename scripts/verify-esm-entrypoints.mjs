#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Node-native ESM smoke test for every publishable workspace package.
 *
 * Verifies that each package's built `dist/` entry point (as declared via
 * `exports['.'].import` or `main`) can be loaded by Node's native ESM
 * resolver without throwing `ERR_MODULE_NOT_FOUND` or any other resolver
 * failure. This guards against the class of bug where `tsc` emits
 * extensionless or directory-style relative imports that bundlers tolerate
 * but Node's strict ESM resolver rejects — the exact failure that bit
 * `@ifc-lite/renderer`'s `dist/snap-detector.js` in CI.
 *
 * Why Node and not the TypeScript compiler:
 *   Even with `moduleResolution: "nodenext"` in tsconfig, someone could
 *   introduce a build step, code generator, or hand-edited `dist/` file
 *   that re-introduces a broken specifier. This smoke test loads the
 *   actual published artifacts through the runtime resolver, so it catches
 *   anything the typechecker misses.
 *
 * Each package is loaded in its own isolated subprocess with a throwaway
 * working directory so CLI packages (which run at module top-level) can't
 * pollute the workspace, and so one package's crash can't break another's
 * test. Only resolver-class errors are treated as failures; if a CLI entry
 * parses argv and calls `process.exit(1)` that is still a pass, because
 * the import itself succeeded.
 *
 * Usage:
 *   node scripts/verify-esm-entrypoints.mjs
 *   node scripts/verify-esm-entrypoints.mjs --timeout 60000
 *
 * Exit codes:
 *   0  every publishable package loaded cleanly
 *   1  one or more packages failed the resolver smoke test
 */

import { readFileSync, readdirSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT_DIR = resolve(__dirname, '..');
const PACKAGES_DIR = join(ROOT_DIR, 'packages');

// ── CLI option parsing ───────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  let timeoutMs = 30_000;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--timeout' && args[i + 1]) timeoutMs = parseInt(args[++i], 10);
  }
  return { timeoutMs };
}

// ── Package discovery ────────────────────────────────────────────────────────

/**
 * Resolves a package's ESM entry point using the same precedence as Node:
 * `exports['.'].import` → `exports['.'].default` → `exports['.']` (string)
 * → `main`. Returns `null` if the package declares none (e.g. `@ifc-lite/wasm`
 * which only exports subpaths).
 */
function resolveEsmEntry(pkg) {
  const exp = pkg.exports;
  if (exp && typeof exp === 'object') {
    const root = exp['.'];
    if (root && typeof root === 'object') {
      return root.import ?? root.default ?? null;
    }
    if (typeof root === 'string') return root;
  }
  return pkg.main ?? null;
}

function discoverPublishablePackages() {
  const out = [];
  for (const dir of readdirSync(PACKAGES_DIR).sort()) {
    const pkgJsonPath = join(PACKAGES_DIR, dir, 'package.json');
    if (!existsSync(pkgJsonPath)) continue;
    const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
    if (pkg.private) continue;
    if (!pkg.name || !pkg.version) continue;

    const entry = resolveEsmEntry(pkg);
    if (!entry) {
      out.push({ name: pkg.name, dir, skip: 'no ESM entry declared' });
      continue;
    }
    const entryAbs = resolve(PACKAGES_DIR, dir, entry);
    if (!existsSync(entryAbs)) {
      out.push({
        name: pkg.name,
        dir,
        skip: `entry missing on disk: ${entry} (did you run \`pnpm build\` first?)`,
      });
      continue;
    }
    out.push({ name: pkg.name, dir, entryAbs });
  }
  return out;
}

// ── Smoke driver ─────────────────────────────────────────────────────────────

/**
 * Import-only probe that runs inside each subprocess. It writes `SMOKE:OK`
 * after the dynamic import resolves, or `SMOKE:FAIL:<code>` if the import
 * rejects with a resolver-class error. Any other rejection (runtime throw,
 * downstream wasm init failure, etc.) is still reported as a FAIL so we
 * catch the full class of publish-time regressions, not just missing-module
 * errors.
 *
 * The inner module is provided via `--input-type=module -e` so we don't need
 * to materialise a temp file.
 */
const INNER_SCRIPT = `
const entryUrl = process.argv[1];
try {
  await import(entryUrl);
  process.stdout.write('SMOKE:OK\\n');
  // Allow the imported module's own top-level effects (CLI argv parsing,
  // process.exit, etc.) to run to completion. We've already recorded the
  // resolver success marker, so whatever happens next doesn't matter.
} catch (e) {
  const code = e && e.code ? e.code : 'UNKNOWN';
  const msg = (e && e.message ? e.message : String(e)).split('\\n')[0];
  process.stdout.write('SMOKE:FAIL:' + code + ':' + msg + '\\n');
  process.exit(42);
}
`;

function smokeTestPackage(pkg, timeoutMs) {
  // Isolate CWD so packages that run CLI code on import (e.g.
  // create-ifc-lite) can't touch the workspace. Create a fresh temp dir
  // per package so one crash can't leave state behind for the next.
  const sandbox = mkdtempSync(join(tmpdir(), 'ifc-lite-smoke-'));
  try {
    const entryUrl = pathToFileURL(pkg.entryAbs).href;
    const child = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', INNER_SCRIPT, entryUrl],
      {
        cwd: sandbox,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, NODE_NO_WARNINGS: '1', CI: '1' },
      }
    );

    const stdout = (child.stdout || Buffer.alloc(0)).toString();
    const stderr = (child.stderr || Buffer.alloc(0)).toString();

    if (child.error && child.error.code === 'ETIMEDOUT') {
      return {
        ok: false,
        reason: `timed out after ${timeoutMs}ms — module hangs during top-level evaluation`,
      };
    }

    // Success: the inner probe wrote SMOKE:OK before anything else ran.
    if (stdout.includes('SMOKE:OK')) return { ok: true };

    // Our probe caught a resolver-class failure.
    const failMatch = stdout.match(/SMOKE:FAIL:([^:]+):(.*)/);
    if (failMatch) {
      return { ok: false, reason: `${failMatch[1]}: ${failMatch[2].trim()}` };
    }

    // No markers at all — the subprocess crashed before our catch() could
    // run, or Node itself surfaced a top-level resolver error. Extract the
    // best available diagnostic from stderr.
    const trimmedErr = stderr.trim().split('\n').slice(-3).join(' | ') || '(no output)';
    return {
      ok: false,
      reason: `subprocess exited with status ${child.status} without SMOKE marker — ${trimmedErr}`,
    };
  } finally {
    try {
      rmSync(sandbox, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

function main() {
  const { timeoutMs } = parseArgs();
  const packages = discoverPublishablePackages();

  const skipped = packages.filter((p) => p.skip);
  const testable = packages.filter((p) => !p.skip);

  console.log(
    `Smoke-testing ${testable.length} publishable package(s) via Node-native ESM ` +
      `(timeout ${timeoutMs}ms each)\n`
  );

  const failures = [];
  for (const pkg of testable) {
    const result = smokeTestPackage(pkg, timeoutMs);
    if (result.ok) {
      console.log(`  ok    ${pkg.name}`);
    } else {
      console.log(`  FAIL  ${pkg.name}`);
      console.log(`        ${result.reason}`);
      failures.push({ name: pkg.name, reason: result.reason });
    }
  }

  for (const pkg of skipped) {
    console.log(`  skip  ${pkg.name}  (${pkg.skip})`);
  }

  console.log();
  console.log(
    `${testable.length - failures.length} passed, ${failures.length} failed, ${skipped.length} skipped`
  );

  if (failures.length) {
    console.error('\nESM smoke test failed. Most likely cause: a relative import in one');
    console.error('of the sources above omits the .js extension (or points at a directory');
    console.error('instead of directory/index.js). TypeScript with moduleResolution:');
    console.error('"nodenext" should reject these at build time — rerun `pnpm build` on');
    console.error('the offending package to see the exact file.\n');
    process.exit(1);
  }
}

main();
