/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pure logic for the revert oracle (`scripts/check-test-revert-oracle.mjs`).
 *
 * The oracle answers one question: if the production hunks of this branch were
 * reverted, would the branch's own tests notice? A test that stays green with
 * its subject removed certifies nothing.
 *
 * THE TRAP THIS MODULE EXISTS FOR. A whole-file revert usually also removes
 * test-only exports (`__resetCacheForTests`, a newly exported helper, a Rust
 * `#[cfg(test)] mod tests` living in the reverted file). The test file then
 * dies at import:
 *
 *   SyntaxError: The requested module './x.ts' does not provide an export
 *   named '__resetCacheForTests'
 *
 * Not one assertion ran. Exit code is non-zero and `# fail` is non-zero, so a
 * naive script scores it "tests failed, therefore the change is covered" —
 * precisely the false reassurance the oracle exists to prevent. Exit code
 * cannot tell an assertion failure from a module that never loaded, so this
 * module parses the runner's own output instead, and any whiff of a load
 * failure downgrades the whole run to INCONCLUSIVE rather than RED.
 *
 * UNDER VITE THE TRAP IS INVISIBLE. Vite does not throw on a missing named
 * export — it binds the import to `undefined`. The module loads, the test body
 * runs, and vitest reports `Failed Tests` with `TypeError: x is not a
 * function`, which has the exact shape of an honest assertion failure. Only
 * the error text tells the two apart.
 *
 * Everything here is a pure function over strings so it can be tested against
 * synthetic fixtures (`revert-oracle.test.mjs`) without reverting anything.
 */

// ---------------------------------------------------------------------------
// Diff classification
// ---------------------------------------------------------------------------

/** Paths whose change can neither be reverted usefully nor observed by a test. */
const IGNORED_PREFIXES = ['.changeset/', '.github/', 'docs/', '.vscode/'];
const IGNORED_EXACT = new Set([
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  'Cargo.lock',
  'CHANGELOG.md',
]);
const IGNORED_SUFFIXES = ['.md', '.mdx', '.txt', '.snap.orig'];

/** A file that IS a test. */
const TEST_FILE_RE = /(^|\/)[^/]*\.(test|spec)\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
/** Directories whose entire contents are test scaffolding, not production. */
const TEST_DIR_RE = /(^|\/)(__tests__|__snapshots__|__fixtures__|test-fixtures|testdata)(\/|$)/;
/** `tests/` and `test/` as a directory segment (but not `src/test-utils.ts`). */
const TEST_SEGMENT_RE = /(^|\/)tests?(\/)/;

/**
 * Rust puts unit tests INSIDE the production file behind `#[cfg(test)]`. Such a
 * file is production, but reverting it takes its tests with it — the Rust form
 * of the export-removal trap. Callers get a warning, not a reclassification.
 */
export function isRustFile(path) {
  return path.endsWith('.rs');
}

export function classifyPath(path) {
  if (IGNORED_EXACT.has(path)) return 'ignored';
  for (const p of IGNORED_PREFIXES) if (path.startsWith(p)) return 'ignored';
  for (const s of IGNORED_SUFFIXES) if (path.endsWith(s)) return 'ignored';
  if (TEST_FILE_RE.test(path)) return 'test';
  if (TEST_DIR_RE.test(path)) return 'test';
  if (TEST_SEGMENT_RE.test(path)) return 'test';
  return 'production';
}

/**
 * @param {Array<{status: string, path: string}>} entries from `git diff --name-status`
 */
export function classifyDiff(entries) {
  const production = [];
  const test = [];
  const ignored = [];
  const warnings = [];
  for (const { status, path } of entries) {
    const kind = classifyPath(path);
    if (kind === 'production') production.push({ status, path });
    else if (kind === 'test') test.push({ status, path });
    else ignored.push({ status, path });
  }
  if (production.some((e) => isRustFile(e.path))) {
    warnings.push(
      'Rust production files are in the revert set. `#[cfg(test)] mod tests` lives ' +
        'inside the file it tests, so a whole-file revert deletes those tests as well ' +
        'as the code — expect INCONCLUSIVE and use --mutation for a surgical revert.',
    );
  }
  return { production, test, ignored, warnings };
}

/** Parse `git diff --name-status -z`-free plain output. Renames carry two paths. */
export function parseNameStatus(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    const status = parts[0];
    // R100 old new / C075 old new -> the NEW path is the one on disk.
    const path = parts.length >= 3 ? parts[2] : parts[1];
    if (path) out.push({ status: status[0], path });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Runner detection
// ---------------------------------------------------------------------------

/**
 * Turn a package's `scripts.test` into a command that runs an EXPLICIT file
 * list. We reuse the script's own flags rather than guessing, because two
 * packages in this repo only work with theirs: `packages/renderer` globs
 * `src/*.test.ts` top-level-only, and `apps/viewer` has no vitest at all and
 * needs `--import ./src/test/vite-module-hooks.mjs`.
 *
 * @returns {{family: string, bin: string, args: string[]}|null}
 */
export function detectRunner(testScript, files) {
  if (typeof testScript !== 'string' || testScript.trim() === '') return null;

  if (/(^|[\s/])vitest\b/.test(testScript)) {
    const args = ['run', '--reporter=default'];
    if (/--passWithNoTests\b/.test(testScript)) {
      // Deliberately NOT forwarded: "no tests" must stay an error for us.
    }
    return { family: 'vitest', bin: 'vitest', args: [...args, ...files] };
  }

  const nodeTest = /--test\b/.test(testScript);
  if (nodeTest) {
    const bin = /(^|[\s/])tsx\b/.test(testScript) ? 'tsx' : 'node';
    const flags = extractNodeFlags(testScript);
    return { family: 'node-test', bin, args: [...flags, '--test', ...files] };
  }

  if (/(^|[\s/])cargo\b/.test(testScript)) return { family: 'cargo', bin: 'cargo', args: ['test'] };

  return null;
}

/** Flags that must survive from the package's own test script. */
export function extractNodeFlags(script) {
  const flags = [];
  const paired = /(--import|--tsconfig|--conditions|--loader|--require)[\s=]+(\S+)/g;
  let m;
  while ((m = paired.exec(script)) !== null) flags.push(m[1], m[2].replace(/^["']|["']$/g, ''));
  const standalone = /--(test-concurrency|test-timeout|test-force-exit|experimental-[\w-]+)(=\S+)?/g;
  while ((m = standalone.exec(script)) !== null) flags.push(`--${m[1]}${m[2] ?? ''}`);
  return flags;
}

/**
 * `scripts/**` has no package of its own: the root `scripts.test` is
 * `turbo test`, which runs the workspace and not these files. CI runs each one
 * with an explicit `node --test scripts/<x>.test.mjs` step, so that is what we
 * reproduce. Only plain-JS test files qualify — anything needing a loader must
 * declare a runner rather than be guessed at.
 */
export function rootScriptsRunner(files) {
  if (!Array.isArray(files) || files.length === 0) return null;
  if (!files.every((f) => /^scripts\/.*\.test\.(mjs|js|cjs)$/.test(f))) return null;
  return { family: 'node-test', bin: 'node', args: ['--test', ...files] };
}

/** Cargo test invocation for a crate. */
export function cargoRunner(crate) {
  if (!crate) return null;
  return { family: 'cargo', bin: 'cargo', args: ['test', '-p', crate] };
}

// ---------------------------------------------------------------------------
// Runner output parsing — the core of the tool
// ---------------------------------------------------------------------------

export const PASS = 'pass';
export const ASSERTION_FAILURE = 'assertion-failure';
export const LOAD_FAILURE = 'load-failure';
export const NO_TESTS = 'no-tests';
export const RUNNER_MISSING = 'runner-missing';
export const UNPARSEABLE = 'unparseable';

/**
 * Errors that mean the module never loaded, so no assertion was ever evaluated.
 * Matched against raw runner output regardless of family — every one of these
 * is fatal at import/compile time in every runner here.
 */
const LOAD_ERROR_PATTERNS = [
  /does not provide an export named/,
  /SyntaxError:/,
  /ERR_MODULE_NOT_FOUND/,
  /Cannot find module/,
  /Cannot find package/,
  /Failed to resolve (?:entry for package|import|module)/,
  /Failed to load url/,
  /ERR_UNKNOWN_FILE_EXTENSION/,
  /ERR_REQUIRE_ESM/,
  /ERR_UNSUPPORTED_DIR_IMPORT/,
  /Transform failed with \d+ error/,
  /\bTSError\b/,
  /error TS\d{4}:/,
  // Deliberately broad: a ReferenceError is far more often a dead import than a
  // real assertion, and biasing it to INCONCLUSIVE costs a human glance, while
  // biasing it to OBSERVED is the false reassurance this tool exists to stop.
  /ReferenceError: .* is not defined/,
  // Vite's dead-binding form of the export-removal trap, and the one that hurts
  // most because it does NOT look like a load error. Node's ESM loader throws at
  // instantiation when a named export is missing; Vite instead binds the import
  // to `undefined`, so the module "loads", the test body runs, and the runner
  // prints an ordinary `Failed Tests` banner. Nothing was tested, yet without
  // this pattern the oracle reads it as "the tests caught the revert".
  //   TypeError: computeThing is not a function   (removed exported function)
  //   TypeError: Mesh is not a constructor        (removed exported class)
  // The cost is a genuine `X is not a function` thrown by product code being
  // downgraded to INCONCLUSIVE. That is the loud, self-correcting direction; a
  // false OBSERVED is the silent one this whole tool exists to prevent.
  // NOTE, and it is the known hole: this covers only the CALLABLE half. A
  // removed export that is read (`CONFIG.limit` -> "Cannot read properties of
  // undefined") or compared directly (`expect(LIMIT).toBe(5)` -> "expected
  // undefined to be 5") still reads as an assertion failure and yields a false
  // OBSERVED. See limitation 7 in check-test-revert-oracle.mjs.
  /TypeError: .* is not a (?:function|constructor)/,
  /The requested module/,
  /Missing "\.\/[^"]*" specifier in/,
  /\[vite\]: Rollup failed to resolve/,
];

/** Runner binary itself absent — never a clean result. */
const RUNNER_MISSING_PATTERNS = [
  /command not found/i,
  /ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL/,
  /Command "\w[\w-]*" not found/i,
  /No such file or directory.*\.bin/,
  /error: no such command/,
];

export function hasLoadError(text) {
  return LOAD_ERROR_PATTERNS.some((re) => re.test(text));
}

function firstMatch(text, patterns) {
  for (const re of patterns) {
    const m = re.exec(text);
    if (m) return m[0];
  }
  return null;
}

/**
 * @param {{family: string, stdout: string, stderr: string, exitCode: number|null, spawnError?: string}} run
 * @returns {{kind: string, passed: number|null, failed: number|null, total: number|null, evidence: string[]}}
 */
export function parseRunnerOutput(run) {
  const { family } = run;
  const text = `${run.stdout ?? ''}\n${run.stderr ?? ''}`;
  const evidence = [];

  if (run.spawnError) {
    return { kind: RUNNER_MISSING, passed: null, failed: null, total: null, evidence: [run.spawnError] };
  }
  const missing = firstMatch(text, RUNNER_MISSING_PATTERNS);
  if (missing) {
    return { kind: RUNNER_MISSING, passed: null, failed: null, total: null, evidence: [missing] };
  }

  const parsed =
    family === 'vitest'
      ? parseVitest(text)
      : family === 'node-test'
        ? parseNodeTest(text)
        : family === 'cargo'
          ? parseCargo(text)
          : null;

  if (!parsed) {
    return { kind: UNPARSEABLE, passed: null, failed: null, total: null, evidence: [`unknown runner family: ${family}`] };
  }

  // A load error ANYWHERE outranks every other signal. Some files may have run
  // their assertions, but at least one subject never loaded, so the run cannot
  // be read as "the tests observed the change".
  // Both signals are recorded: the STRUCTURAL one (the runner reported a file
  // rather than a test) and the TEXTUAL one (the actual import/compile error).
  // A human reading an INCONCLUSIVE needs the error text to write the surgical
  // mutation, so it must never be shadowed by the structural summary.
  const textualHit = firstMatch(text, LOAD_ERROR_PATTERNS);
  for (const hit of [textualHit, parsed.loadEvidence]) if (hit) evidence.push(hit);
  if (evidence.length > 0) {
    return { kind: LOAD_FAILURE, passed: parsed.passed, failed: parsed.failed, total: parsed.total, evidence };
  }

  if (parsed.kind) return { ...parsed, evidence: parsed.evidence ?? [] };

  if (parsed.total === 0) {
    return { kind: NO_TESTS, passed: 0, failed: 0, total: 0, evidence: ['runner collected zero tests'] };
  }
  if (parsed.total === null) {
    return { kind: UNPARSEABLE, passed: null, failed: null, total: null, evidence: ['no test summary found in runner output'] };
  }
  if (parsed.failed > 0) {
    return { kind: ASSERTION_FAILURE, passed: parsed.passed, failed: parsed.failed, total: parsed.total, evidence: parsed.evidence ?? [] };
  }
  return { kind: PASS, passed: parsed.passed, failed: parsed.failed, total: parsed.total, evidence: [] };
}

function parseVitest(text) {
  if (/No test files found/.test(text)) {
    return { kind: NO_TESTS, passed: 0, failed: 0, total: 0, evidence: ['vitest: No test files found'] };
  }
  // `⎯ Failed Suites N ⎯` is vitest's banner for collection-time failures —
  // the file never produced a test. `Failed Tests` is the assertion banner.
  const failedSuites = /Failed Suites\s+(\d+)/.exec(text);
  const loadEvidence = failedSuites ? `vitest reported ${failedSuites[1]} Failed Suite(s) (collection error, no assertion ran)` : null;

  const m = /^\s*Tests\s+(.+)$/m.exec(text);
  if (!m) {
    // `Test Files 1 failed (1)` with no `Tests` line at all == everything died
    // during collection.
    if (/Test Files\s+\d+ failed/.test(text)) {
      return { passed: 0, failed: null, total: null, loadEvidence: loadEvidence ?? 'vitest: test files failed with no Tests summary' };
    }
    return { passed: null, failed: null, total: null, loadEvidence };
  }
  const summary = m[1];
  if (/no tests/.test(summary)) {
    return { passed: 0, failed: 0, total: 0, loadEvidence: loadEvidence ?? 'vitest: "Tests  no tests"' };
  }
  const passed = num(/(\d+)\s+passed/.exec(summary));
  const failed = num(/(\d+)\s+failed/.exec(summary));
  const totalM = /\((\d+)\)\s*$/.exec(summary);
  const total = totalM ? Number(totalM[1]) : (passed ?? 0) + (failed ?? 0);
  return { passed: passed ?? 0, failed: failed ?? 0, total, loadEvidence };
}

function parseNodeTest(text) {
  const total = num(/^#\s*tests\s+(\d+)\s*$/m.exec(text));
  const pass = num(/^#\s*pass\s+(\d+)\s*$/m.exec(text));
  const fail = num(/^#\s*fail\s+(\d+)\s*$/m.exec(text));
  if (total === null) return { passed: pass, failed: fail, total: null, loadEvidence: null };

  // A file that fails to LOAD is reported by node --test as a top-level
  // `not ok N - <absolute path of the test file>` carrying `error: 'test failed'`
  // and an `exitCode:` field — never a test NAME. A file whose assertions fail
  // reports the failing test names instead. This is the discriminator that
  // exit code cannot give us.
  let loadEvidence = null;
  const notOk = /^not ok \d+ - (.+)$/gm;
  let m;
  while ((m = notOk.exec(text)) !== null) {
    const desc = m[1].trim();
    if (/\.(test|spec)\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(desc)) {
      loadEvidence = `node --test failed the whole FILE, not a test: "not ok - ${desc}" (the file never produced a subtest)`;
      break;
    }
  }
  return { passed: pass ?? 0, failed: fail ?? 0, total, loadEvidence };
}

function parseCargo(text) {
  if (/error(\[E\d+\])?:/.test(text) && /could not compile|aborting due to|unresolved import|cannot find/.test(text)) {
    const hit = /^error(\[E\d+\])?: .*$/m.exec(text);
    return { passed: null, failed: null, total: null, loadEvidence: `cargo compile error: ${hit ? hit[0] : 'build failed'}` };
  }
  const results = [...text.matchAll(/test result: (\w+)\. (\d+) passed; (\d+) failed;/g)];
  if (results.length === 0) return { passed: null, failed: null, total: null, loadEvidence: null };
  let passed = 0;
  let failed = 0;
  for (const r of results) {
    passed += Number(r[2]);
    failed += Number(r[3]);
  }
  return { passed, failed, total: passed + failed, loadEvidence: null };
}

function num(m) {
  return m ? Number(m[1]) : null;
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

export const OBSERVED = 'OBSERVED';
export const UNOBSERVED = 'UNOBSERVED';
export const INCONCLUSIVE = 'INCONCLUSIVE';
export const BASELINE_BROKEN = 'BASELINE-BROKEN';

/**
 * @param {{baseline: object, reverted: object}} args results from parseRunnerOutput
 */
export function verdict({ baseline, reverted }) {
  if (!baseline || !reverted) {
    return { verdict: INCONCLUSIVE, exitCode: 3, reason: 'a run is missing', advice: SURGICAL_ADVICE };
  }
  if (baseline.kind !== PASS) {
    return {
      verdict: BASELINE_BROKEN,
      exitCode: 3,
      reason:
        `the branch's own tests do not pass before any revert (${baseline.kind}` +
        `${baseline.evidence?.length ? `: ${baseline.evidence[0]}` : ''}). ` +
        'Nothing can be concluded from reverting on top of a red baseline.',
      advice: 'Get the branch green first (build workspace deps if the failure is a missing dist/).',
    };
  }
  if (baseline.total === 0) {
    return { verdict: INCONCLUSIVE, exitCode: 3, reason: 'baseline collected zero tests', advice: SURGICAL_ADVICE };
  }

  if (reverted.kind === LOAD_FAILURE) {
    return {
      verdict: INCONCLUSIVE,
      exitCode: 3,
      reason:
        'with production reverted the test file failed to LOAD, so no assertion ever ran. ' +
        `This is NOT evidence the change is covered. Evidence: ${reverted.evidence[0] ?? 'load error'}`,
      advice: SURGICAL_ADVICE,
    };
  }
  if (reverted.kind === RUNNER_MISSING || reverted.kind === UNPARSEABLE) {
    return {
      verdict: INCONCLUSIVE,
      exitCode: 3,
      reason: `the reverted run produced no readable result (${reverted.kind}): ${reverted.evidence[0] ?? ''}`,
      advice: SURGICAL_ADVICE,
    };
  }
  if (reverted.kind === NO_TESTS) {
    return {
      verdict: INCONCLUSIVE,
      exitCode: 3,
      reason: 'with production reverted the runner collected zero tests — the suite vanished rather than failed.',
      advice: SURGICAL_ADVICE,
    };
  }
  // Tests silently disappeared: some file died on the way in even though other
  // files produced honest assertion failures. Cannot attribute the RED.
  if (
    typeof baseline.total === 'number' &&
    typeof reverted.total === 'number' &&
    reverted.total < baseline.total
  ) {
    return {
      verdict: INCONCLUSIVE,
      exitCode: 3,
      reason:
        `the reverted run collected FEWER tests than the baseline (${reverted.total} < ${baseline.total}). ` +
        'Tests disappeared rather than failed, so the RED cannot be attributed to the production change.',
      advice: SURGICAL_ADVICE,
    };
  }
  if (reverted.kind === ASSERTION_FAILURE) {
    return {
      verdict: OBSERVED,
      exitCode: 0,
      reason: `reverting production turned ${reverted.failed} assertion(s) RED out of ${reverted.total} collected. The change is observed.`,
      advice: null,
    };
  }
  if (reverted.kind === PASS) {
    return {
      verdict: UNOBSERVED,
      exitCode: 1,
      reason:
        `FINDING: with the production change fully reverted, all ${reverted.total} test(s) still PASS. ` +
        'The branch\'s tests do not observe the branch\'s change.',
      advice:
        'Either the test asserts something the change does not affect, or it stubs the very module ' +
        'the change lives in. Write a test that fails on this revert before shipping.',
    };
  }
  return { verdict: INCONCLUSIVE, exitCode: 3, reason: `unhandled reverted kind: ${reverted.kind}`, advice: SURGICAL_ADVICE };
}

export const SURGICAL_ADVICE =
  'Re-run with --mutation <patch>: hand-write a reverse patch that removes ONLY the behavioural lines ' +
  'and keeps the test-only exports / signatures the test file imports. A blunt whole-file revert ' +
  'deletes the seam the test enters through, and a dead import is not a RED.';

// ---------------------------------------------------------------------------
// Aggregation across packages
// ---------------------------------------------------------------------------

/**
 * A branch can touch several packages, each with its own runner. The aggregate
 * takes the WORST kind, not the most common one: one package whose suite failed
 * to load poisons the whole conclusion, however green the others were.
 */
const KIND_SEVERITY = [PASS, ASSERTION_FAILURE, NO_TESTS, LOAD_FAILURE, UNPARSEABLE, RUNNER_MISSING];

export function aggregate(results) {
  if (!Array.isArray(results) || results.length === 0) {
    return { kind: UNPARSEABLE, passed: null, failed: null, total: null, evidence: ['no packages were run'] };
  }
  let worst = results[0];
  for (const r of results) {
    if (KIND_SEVERITY.indexOf(r.kind) > KIND_SEVERITY.indexOf(worst.kind)) worst = r;
  }
  const sum = (key) =>
    results.every((r) => typeof r[key] === 'number') ? results.reduce((a, r) => a + r[key], 0) : null;
  return {
    kind: worst.kind,
    passed: sum('passed'),
    failed: sum('failed'),
    total: sum('total'),
    evidence: results.flatMap((r) => r.evidence ?? []),
  };
}
