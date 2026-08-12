#!/usr/bin/env node

/**
 * Runs both halves of a release — npm, then crates.io — and reports on both.
 *
 * This exists because the two were chained with `&&`:
 *
 *     pnpm release:npm && pnpm release:crates
 *
 * which makes the Rust half a hostage of the JavaScript half. On 2026-08-12
 * `changeset publish` exited non-zero on ONE package (`@ifc-lite/source-dalux`,
 * never published, so trusted publishing cannot create it — npm 404 on PUT).
 * Every other npm package published fine, and `release:crates` then never ran.
 * crates.io had been stranded at 4.3.0 since 2026-08-03 for that reason, while
 * npm advanced through 4.4.0 to 4.4.1 — nine days in which the Rust fixes those
 * npm changelogs advertised were not reachable from crates.io at all.
 *
 * Neither half is a precondition of the other: they publish to different
 * registries from the same already-built artifacts. So both always run, and
 * the exit code is non-zero if EITHER failed. A failure is never masked — the
 * summary names which half broke, and a half that succeeded is not re-run or
 * rolled back by the other's failure.
 *
 * `scripts/release-crates.mjs` skips versions already on crates.io, and
 * `changeset publish` skips versions already on npm, so re-running after a
 * partial failure is safe and picks up only what is missing.
 */

import { spawnSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The two halves, in the order their output reads best. npm first: it is the
 *  primary distribution channel and the one whose log the release action parses
 *  for the published-package list. */
const STEPS = [
  { name: 'npm', script: 'release:npm' },
  { name: 'crates.io', script: 'release:crates' },
];

const failed = [];

for (const step of STEPS) {
  console.log(`\n▶️  release: ${step.name} (pnpm ${step.script})`);
  const result = spawnSync('pnpm', [step.script], {
    cwd: rootDir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  // A signal-killed child reports status null; treat anything that is not a
  // clean 0 as a failure rather than letting `null !== 0` decide it silently.
  const code = result.status ?? (result.error ? 1 : 1);
  if (code === 0) {
    console.log(`✅ release: ${step.name} finished`);
    continue;
  }
  failed.push({ ...step, code, error: result.error });
  // Keep going: the other registry is independent, and stranding it is the
  // exact defect this script was written to remove.
  console.error(`❌ release: ${step.name} FAILED (exit ${code}) — continuing with the remaining registries`);
}

if (failed.length > 0) {
  console.error(
    `\n❌ release incomplete — failed: ${failed.map((f) => f.name).join(', ')}`,
  );
  for (const f of failed) {
    if (f.error) console.error(`   ${f.name}: ${f.error.message}`);
  }
  process.exit(1);
}

console.log('\n✅ release complete — npm and crates.io both published');
