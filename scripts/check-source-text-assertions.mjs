#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Ratchet: a test may not read its own subject's SOURCE and assert on the text
 * (#2434).
 *
 * A test that does `readFileSync('Thing.tsx')` and then `.includes('someCall(')`
 * certifies that a string exists, not that the code works. It is weak in both
 * directions — green while the behaviour is broken, red on a harmless rename.
 * The measured case: `SearchModal.filter.wiring.test.tsx` asserted the whole body
 * of `handleRowClick`, and stayed 5/5 green when `onRowClick={handleRowClick}`
 * was replaced with `onRowClick={() => {}}` — defect #2396 verbatim, a click
 * that does nothing.
 *
 * The pattern kept spreading because the alternative looked impossible: three
 * test files carried the same sentence, "reads the store directly via
 * `useViewerStore`, so it cannot be mounted under `tsx --test`". That was never
 * true; what was true is that two Vite-isms broke the import, and nobody had
 * paid the one-time cost of fixing them. `apps/viewer/src/test/` now does
 * (`vite-module-hooks.mjs`, `dom-layout.ts`, `render.tsx`, `store-fixture.ts`),
 * and AGENTS.md documents the recipe.
 *
 * So this guard exists to stop NEW ones landing while the existing list is
 * converted. Everything already in the allowlist is grandfathered with a reason;
 * the file is expected to shrink and must never grow.
 *
 * Run via `node scripts/check-source-text-assertions.mjs` (CI node-test job).
 *
 * DETECTION is deliberately lexical, not data-flow: every real instance names
 * its subject in a string literal in the same file, though often through a
 * shared `readSource('Thing.tsx')` helper, so the read and the literal cannot
 * be required to sit near each other.
 *
 * COMMENTS ARE STRIPPED FIRST, and that is load-bearing rather than tidy: three
 * unrelated tests mention a `.ts` filename in prose ("as per `safe-path.test.ts`",
 * "apache-arrow hides the `.d.ts`") while reading a wasm binary or a JSON
 * manifest, and matching those flagged all three. It is the same trap the test
 * this guard was born from fell into -- an assertion that matched its own
 * explanatory comment instead of the code.
 */

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SEARCH_DIRS = ['packages', 'apps'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'pkg', 'build', 'coverage', '.turbo', 'generated']);
const TEST_FILE_RE = /\.(test|spec)\.(ts|tsx|mts)$/;

const ALLOWLIST_PATH = join(ROOT, 'scripts', 'source-text-assertion-allowlist.txt');

/**
 * Exact size the allowlist is expected to have, recorded HERE rather than in the
 * allowlist itself: a ceiling derived from the file it guards is circular and
 * always passes.
 *
 * The allowlist's own header says it "only ratchets DOWN", but nothing enforced
 * that. Adding a violating file AND its allowlist row in one commit satisfied
 * every check, because the new file was allowlisted by the time the "new file"
 * scan ran - so the escape hatch was invisible in the gate's own output. The
 * list grew 5 -> 6 that way (#2531).
 *
 * Both directions now fail, matching scripts/check-unused-locals.mjs: growth
 * must edit this number, which makes "this PR loosened a gate" a reviewable line
 * in the diff, and a conversion must lower it in the same PR so the ceiling
 * stays an exact statement rather than drifting into slack.
 *
 * 6 -> 7 (#2393, #2388): the wasm-path `ifc_model_loaded` capture cannot be
 * driven behaviourally — `GeometryProcessor.init()` throws on the `file://`
 * wasm fetch under node/happy-dom before `loadStage` leaves `engine-init`, so
 * the flow being instrumented never fires in-harness. Raised deliberately and
 * in the same commit as the row, which is what this constant exists to force.
 * The cache-hit half of #2388 is NOT covered by that exception and is tested
 * behaviourally against real `posthog.capture` payloads.
 *
 * Raised to 8 for `packages/data/scripts/generate-ifc-schema.test.ts`, and that
 * one is a DIFFERENT kind of entry from every other row: it is not a
 * source-text assertion at all. It trips READS_A_FILE, SOURCE_LITERAL and
 * TEXT_PREDICATE without the three being related -- fixture reads, a
 * copyFileSync of the script under test, and `.indexOf()` splicing fixture
 * text. Separating that from a real hit needs to track which variable holds
 * file contents; two cheaper rules were measured against the rows above and
 * lost coverage (4 of 7 and 3 of 7 caught), so both were rejected rather than
 * shipped for the convenience of one file.
 */
const ALLOWLIST_CEILING = 8;

/** Reads a file from disk at all. */
const READS_A_FILE = /\b(readFileSync|readFile)\s*\(/;

/**
 * Names a SOURCE file as a literal. Fixture formats (.ifc, .json, .csv, …) are
 * deliberately absent: reading a fixture and asserting on it is a normal test.
 */
const SOURCE_LITERAL = /['"`][^'"`\n]*\.(ts|tsx|mts|rs|css|scss)['"`]/;

/**
 * Asserts on text rather than on behaviour. `test` is in the list because
 * `/re/.test(source)` is how this repo already writes them
 * (export-ui-parity.test.tsx:104, :388) — omitting it left the most likely
 * next instance undetected.
 *
 * `exec` is here for the same reason, and was found the same way (#2434):
 * `packages/geometry/src/prepass-class-spans.test.ts` regexes a `.rs` file with
 * `new RegExp(...).exec(src)`, and this guard did not see it at all. Every
 * other predicate listed has a matching `.exec` spelling, so omitting it left
 * the guard blind to a one-character rewrite of a form it already catches.
 */
const TEXT_PREDICATE =
  /(\.(includes|indexOf|match|search|startsWith|endsWith|exec)|\/\s*\.test)\s*\(|\.test\s*\(\s*(source|src|text|body|content|contents)\b|\.(toContain|toMatch)\s*\(/;

/**
 * Assertions on a spawned process's own output are BEHAVIOURAL, not source-text,
 * and stripping them before the predicate runs is what stops this guard firing
 * on a test that merely happens to read files for fixture setup.
 *
 * `packages/data/scripts/generate-ifc-schema.test.ts` is the case that forced
 * this: it copies vendored `.g.cs` data into a temp directory, renames a marker,
 * runs the generator, and asserts `r.status` is non-zero and `r.stderr` names
 * the missing marker. Every `readFileSync` there is fixture setup; not one reads
 * a source file to assert on its text. File-level co-occurrence of
 * `readFileSync` and `.toContain(` was enough to flag it, which is a false
 * positive on exactly the shape this guard wants people to write.
 *
 * `{0,200}` on the receiver runs, not `*`. Two unbounded runs before a required
 * `)` backtrack QUADRATICALLY when the input has no `)` at all. Measured on
 * `'expect(' + '.status'.repeat(n)`:
 *
 *     n=4000    unbounded 41.6ms   newline-excluded 49.4ms   bounded 0.1ms
 *     n=16000   unbounded 657.9ms  newline-excluded 720.1ms  bounded 0.0ms
 *
 * Excluding the newline alone does NOT help -- that input has no newlines, so
 * `[^)\n]*` and `[^)]*` behave identically. Only the length bound flattens it.
 * 200 is far above any real receiver: the longest real one in the tree is 41
 * chars, and the longest `)`-free stretch in any test file is roughly 4.5k --
 * both orders of magnitude past the bound either way. Stated loosely on
 * purpose, because an exact count here is measured on the COMMENT-STRIPPED
 * text this regex actually sees, not on raw source, and goes stale on the next
 * commit regardless. Matcher
 * ARGS do span lines, which is why `[^;]*?` below stays unbounded.
 *
 * Deliberately narrow: only `.status`, `.stdout` and `.stderr` receivers are
 * dropped, so `expect(readFileSync(x)).toContain(y)` is untouched. A test that
 * genuinely asserts on file text cannot hide behind this by renaming a
 * variable, because the receiver property is what is matched, not its name.
 */
const PROCESS_OUTPUT_ASSERTION =
  /\bexpect\s*\([^)\n]{0,200}\.(status|stdout|stderr)\b[^)\n]{0,200}\)\s*(\.\s*not)?\s*\.\s*(toContain|toMatch|toBe|toEqual)\s*\([^;]*?\)/g;

/** Blank process-output assertions so only file-text ones reach TEXT_PREDICATE. */
function stripProcessOutputAssertions(text) {
  return text.replace(PROCESS_OUTPUT_ASSERTION, '');
}

function walk(dir, found = []) {
  // Fail closed. Swallowing an unreadable directory would let this guard
  // report success while never having looked at the file that broke the rule
  // -- the exact "cannot catch its own regression" shape it exists to prevent.
  const entries = readdirSync(dir);
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry) || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) walk(full, found);
    else if (TEST_FILE_RE.test(entry)) found.push(full);
  }
  return found;
}

/** Drop `//` and block comments, so prose about a `.ts` file cannot flag a test. */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => line.replace(/(^|[^:'"`\\])\/\/.*$/, '$1'))
    .join('\n');
}

function loadAllowlist() {
  if (!existsSync(ALLOWLIST_PATH)) return new Set();
  return new Set(
    readFileSync(ALLOWLIST_PATH, 'utf8')
      .split('\n')
      .map((line) => line.replace(/#.*$/, '').trim())
      .filter(Boolean)
  );
}

const allowlist = loadAllowlist();
const offenders = [];
const staleAllowlistEntries = new Set(allowlist);

for (const dir of SEARCH_DIRS) {
  for (const file of walk(join(ROOT, dir))) {
    const rel = relative(ROOT, file).split('\\').join('/');
    const source = stripComments(readFileSync(file, 'utf8'));
    const assertions = stripProcessOutputAssertions(source);
    const flagged =
      READS_A_FILE.test(source) && SOURCE_LITERAL.test(source) && TEXT_PREDICATE.test(assertions);
    if (!flagged) continue;
    if (allowlist.has(rel)) {
      staleAllowlistEntries.delete(rel);
      continue;
    }
    offenders.push(rel);
  }
}

let failed = false;

if (offenders.length > 0) {
  failed = true;
  console.error('\nSource-text assertions found in NEW test files:\n');
  for (const file of offenders) console.error(`  ${file}`);
  console.error(`
These read a source file and assert on its text. That certifies a string
exists, not that the code works — it passes while the behaviour is broken.

Write a behavioural test instead. For viewer components the harness is ready:

  import '@/test/setup-dom.js';
  import { installLayout } from '@/test/dom-layout.js';
  installLayout();                       // only if the component virtualizes
  import { render, click, advance, cleanup } from '@/test/render.js';
  import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';

  useViewerStore.setState({ ...fixtureModels(fixtureModel('m')) });
  const ui = render(<YourComponent />);
  click(/* the thing a user clicks */);
  assert.equal(useViewerStore.getState().somethingObservable, expected);

See AGENTS.md ("Testing a viewer component") and
apps/viewer/src/components/viewer/SearchModal.filter.wiring.test.tsx.

If the behavioural version is genuinely out of reach, add the file to
scripts/source-text-assertion-allowlist.txt WITH a one-line reason.
`);
}

if (staleAllowlistEntries.size > 0) {
  failed = true;
  console.error('\nAllowlisted files that no longer contain a source-text assertion:\n');
  for (const file of staleAllowlistEntries) console.error(`  ${file}`);
  console.error(`
Converted, or deleted. Either way remove the line from
scripts/source-text-assertion-allowlist.txt — the allowlist only ratchets down.
`);
}

if (allowlist.size > ALLOWLIST_CEILING) {
  failed = true;
  console.error(`
The allowlist has ${allowlist.size} entries but the recorded ceiling is ${ALLOWLIST_CEILING}.

Adding a row is a deliberate loosening of this gate, so it must be visible in
review: raise ALLOWLIST_CEILING in scripts/check-source-text-assertions.mjs in
the SAME commit, and say in the PR why the behavioural test is out of reach.
`);
} else if (allowlist.size < ALLOWLIST_CEILING) {
  failed = true;
  console.error(`
The allowlist is down to ${allowlist.size} entries but the ceiling still reads ${ALLOWLIST_CEILING}.

Lower ALLOWLIST_CEILING to ${allowlist.size} in scripts/check-source-text-assertions.mjs
so the ceiling keeps stating the real number. Slack in a ratchet is how it stops
ratcheting.
`);
}

if (failed) process.exit(1);

console.log(
  `check-source-text-assertions: OK (${allowlist.size} allowlisted, 0 new)`
);
