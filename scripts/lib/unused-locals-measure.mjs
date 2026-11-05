/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { writeTestProgram, GENERATED_CONFIG } from '../typecheck-tests.mjs';
import { classifyTscOutput, untrustworthyExitReason } from './unused-locals-classify.mjs';

/**
 * Strip ANSI escape sequences (SGR colour/style codes) from captured child
 * output before matching. `--pretty false` below already asks tsc for plain
 * text, but this is the defense-in-depth layer: it also covers colour
 * injected by pnpm's own wrapper output, or by any future tool in this
 * spawn chain that doesn't have an equivalent flag. Un-stripped ANSI codes
 * land mid-token (`\x1b[91merror\x1b[0m TS6196:`) and silently break both
 * regexes above — two contributors independently hit this via `FORCE_COLOR`
 * in their shell, and the failure looked exactly like ~30 broken packages.
 */
// Built from String.fromCharCode rather than a /\x1b.../ literal: a literal
// control-character escape in a regex trips oxlint's no-control-regex rule
// (scripts/ is linted, see check-lint-ran.mjs), and that lint failure is
// exactly the kind of thing this script's own defense-in-depth is meant to
// avoid becoming collateral damage from.
const ANSI_ESCAPE_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, 'g');

function stripAnsi(str) {
  return str.replace(ANSI_ESCAPE_RE, '');
}

/**
 * The project to measure a package through.
 *
 * A package's own tsconfig cannot see its tests: the root config excludes
 * `**\/*.test.ts` and `exclude` filters `include`, so `src/**\/*` cannot bring
 * them back. Measuring that program reports a package with dead imports in its
 * tests as clean — `packages/merge`, `plugin-api` and `provenance` all sat at a
 * baseline of 0 while their tests carried unused imports.
 *
 * `typecheck-tests.mjs` already solves this for the typecheck lane, with a
 * generated program that lists the test files under `files` (which `exclude`
 * does not filter). It extends the package's own tsconfig, so it is a superset:
 * one run covers src and tests both, and the check costs no more than before.
 */
function projectFor(repoRoot, dir) {
  const pkgDir = join(repoRoot, dir);
  const generated = writeTestProgram(pkgDir);
  return generated ? GENERATED_CONFIG : 'tsconfig.json';
}

/** Count "declared but never read" diagnostics in one package. */
export function countViolations(repoRoot, dir) {
  const project = projectFor(repoRoot, dir);
  try {
    execFileSync('pnpm', ['exec', 'tsc', '--noEmit', '--noUnusedLocals', '--pretty', 'false', '-p', project], {
      cwd: join(repoRoot, dir), encoding: 'utf8', stdio: 'pipe', maxBuffer: 32 * 1024 * 1024,
      // `--pretty false` is the primary defense: it is tsc's own supported flag
      // for stable, colour-free, machine-readable diagnostics, verified against
      // the pinned TypeScript 6.0.3 (`--help` lists it; a plain-text run under
      // FORCE_COLOR=3 confirmed it strips colour regardless of the parent
      // environment). FORCE_COLOR/NO_COLOR here are the belt-and-suspenders
      // second layer, covering pnpm's own wrapper output in case a future pnpm
      // version colourises it even when the child doesn't.
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    });
    return { count: 0, unmeasurable: false };
  } catch (err) {
    // Third layer: strip any ANSI that made it through anyway (e.g. a tool
    // upstream of tsc in this spawn chain that ignores both of the above)
    // before matching, rather than trusting the two defenses above blindly.
    const output = stripAnsi(`${err.stdout ?? ''}${err.stderr ?? ''}`);
    // Before the text is classified at all: was this even a tsc run that
    // finished? A truncated capture (ENOBUFS) or a killed child (OOM/SIGKILL)
    // hands back a PREFIX of tsc's diagnostics, and a prefix of well-formed
    // diagnostics parses perfectly — 5000 diagnostics came back as a confident
    // `{ kind: 'violations', count: 97 }` in the #2663 review, with err.code
    // unread. `--update` would then bake that undercount into the baseline and
    // lower the bar permanently. Only a plain numeric exit status is trusted.
    const badExit = untrustworthyExitReason(err);
    if (badExit) {
      console.error(`❌ check-unused-locals could not run tsc to completion for ${dir}: ${badExit}.`);
      console.error('   Any diagnostics captured are a truncated prefix, not a complete count,');
      console.error('   so this run cannot be measured — and must never be written to the baseline.');
      console.error('\n   Raw (ANSI-stripped) partial output:\n');
      console.error(output.split('\n').map((l) => `   ${l}`).join('\n'));
      process.exit(1);
    }
    // The actual accounting lives in scripts/lib/unused-locals-classify.mjs,
    // unit-tested on its own (scripts/lib/unused-locals-classify.test.mjs) —
    // including the mixed-output case where one diagnostic parses fine and a
    // second, in the same run, does not. That case must fail loud too, not
    // just the fully-unparseable one (#2634 review).
    const result = classifyTscOutput(output);
    if (result.kind === 'does-not-compile') {
      // The package does not compile. That belongs to the typecheck lane, not
      // here — but it must not silently drop out of the ratchet either, or
      // breaking a build becomes a way to lose the guard. Reported, not skipped.
      return { count: result.count, unmeasurable: true };
    }
    if (result.kind === 'unparseable') {
      // tsc printed at least one `TS####`-shaped diagnostic that classifyTscOutput
      // could not fully account for — whether or not OTHER diagnostics in the
      // same run parsed fine. That is not a compile error to report and fold
      // into the ratchet; it means this script's own parsing is broken (a tsc
      // output-format change, an escape sequence the strip above doesn't
      // cover, etc). Reporting only the recognised diagnostics would be a
      // confidently wrong answer wearing the same clothes as a real, complete
      // count. Fail the whole run loudly instead of guessing.
      console.error(`❌ check-unused-locals cannot parse tsc's output for ${dir}.`);
      console.error('   tsc reported at least one TS diagnostic that matched neither the');
      console.error('   unused-locals codes nor the generic "other error" pattern — this is a');
      console.error('   bug in the check\'s parsing, not a compile error in the package.');
      console.error('\n   Raw (ANSI-stripped) output:\n');
      console.error(output.split('\n').map((l) => `   ${l}`).join('\n'));
      process.exit(1);
    }
    if (result.kind === 'no-diagnostics') {
      // Non-zero exit, and nothing here explains it: no unused diagnostics, no
      // other `error TS####`, no TS diagnostic of any kind. The exit itself
      // was clean (a killed child, a truncated capture and a failed spawn all
      // exited above), so tsc ran and returned non-zero while printing a
      // failure in a shape this does not parse. The one thing that must not
      // happen is calling it zero, which would read as a clean package and
      // could be written into the baseline as one (review, #2603).
      return { count: 0, unmeasurable: true };
    }
    return { count: result.count, unmeasurable: false };
  }
}
