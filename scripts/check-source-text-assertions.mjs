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
 * DETECTION lives in scripts/source-text-assertion-detect.mjs, and REQUIRES THE
 * PAIRING the sentence above states: the predicate must be applied to the value
 * a file read produced. It used to check the two halves independently -- "this
 * file reads something" AND "this file applies a text predicate somewhere" --
 * which is a proxy, and it broke the way proxies break:
 * packages/data/scripts/generate-ifc-schema.test.ts reads upstream fixtures only
 * to copy them into a temp dir, runs the real generator as a child process, and
 * asserts solely on its stdout/stderr, yet was reported as a source-text
 * assertion. Narrowing a ratchet is itself a loosening, so both halves of that
 * change are pinned in scripts/check-source-text-assertions.test.mjs.
 *
 * IF YOU ARE HERE BECAUSE A CORRECT TEST IS FLAGGED: the escape hatch is an
 * `// @source-text-assertion-ok <reason>` comment on the assertion's own line or
 * the line above it, in the style of `@unwired-by-design`. It exists for the
 * anchor guard -- `assert.ok(source.includes(from))` before a
 * `source.replace(from, to)`, which asserts on file text precisely so a mutation
 * that silently fails to apply cannot test nothing. Marked sites are counted and
 * NAMED in this check's output, and a marker that excuses nothing is an error,
 * so an exemption stays a reviewable line rather than a silent hole. Prefer it
 * to the allowlist, which is for whole files that cannot be converted at all.
 *
 * COMMENTS ARE STRIPPED FIRST, and that is load-bearing rather than tidy: three
 * unrelated tests mention a `.ts` filename in prose ("as per `safe-path.test.ts`",
 * "apache-arrow hides the `.d.ts`") while reading a wasm binary or a JSON
 * manifest, and matching those flagged all three. It is the same trap the test
 * this guard was born from fell into -- an assertion that matched its own
 * explanatory comment instead of the code.
 *
 * SCAN SCOPE is packages/ and apps/ test files only; scripts/*.test.mjs are not
 * scanned. That is a deliberate limit, not an oversight: those files run gates
 * against real repo inputs through indirect mutator callbacks, and the taint
 * analysis has to fail closed there, so bringing them in scope would demand
 * markers on assertions that are about a gate's output rather than about source
 * text. Widening the scope means paying that down first.
 */

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze } from './source-text-assertion-detect.mjs';

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
 */
const ALLOWLIST_CEILING = 7;

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
const markedSites = [];
const deadMarkers = [];
const staleAllowlistEntries = new Set(allowlist);

for (const dir of SEARCH_DIRS) {
  for (const file of walk(join(ROOT, dir))) {
    const rel = relative(ROOT, file).split('\\').join('/');
    const result = analyze(readFileSync(file, 'utf8'));
    for (const line of result.unusedMarkers) deadMarkers.push(`${rel}:${line}`);
    for (const site of result.marked) markedSites.push(`${rel}:${site.line}  ${site.reason}`);
    if (!result.flagged) continue;
    if (allowlist.has(rel)) {
      staleAllowlistEntries.delete(rel);
      continue;
    }
    for (const hit of result.hits) offenders.push(`${rel}:${hit.line}  ${hit.text}`);
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

If the assertion is an ANCHOR GUARD -- asserting the anchor exists before a
mutation is built on it, so a mutation that silently stops applying cannot
leave the test asserting nothing -- mark that line instead:

  // @source-text-assertion-ok mutation anchor guard, not a subject assertion
  assert.ok(source.includes(anchor), \`anchor drifted: \${anchor}\`);

Marked sites stay named in this check's output; they are not exemptions in
the dark.
`);
}

if (deadMarkers.length > 0) {
  failed = true;
  console.error('\n@source-text-assertion-ok markers that excuse nothing:\n');
  for (const site of deadMarkers) console.error(`  ${site}`);
  console.error(`
Either the marker has no reason after it, or the assertion it excused is gone
or moved. A marker sits on the assertion's own line or above it, and an
assertion wrapped over several lines counts as one: the marker may sit above
the line the assertion STARTS on, which is where this message shows it.
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

for (const site of markedSites) {
  console.log(`  marked @source-text-assertion-ok: ${site}`);
}
console.log(
  `check-source-text-assertions: OK (${allowlist.size} allowlisted, ${markedSites.length} marked, 0 new)`
);
