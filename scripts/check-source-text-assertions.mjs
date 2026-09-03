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
 * above it, in the style of `@unwired-by-design`. It exists for the anchor
 * guard -- `assert.ok(source.includes(from))` before a
 * `source.replace(from, to)`, which asserts on file text precisely so a mutation
 * that silently fails to apply cannot test nothing. Marked sites are counted and
 * NAMED in this check's output, and a marker that excuses nothing is an error,
 * so an exemption stays a reviewable line rather than a silent hole. Prefer it
 * to the allowlist, which is for whole files that cannot be converted at all.
 * An assertion wrapped over several lines counts as one, so the marker may sit
 * anywhere from one line above the ENCLOSING STATEMENT down to the predicate,
 * and may also be written after the assertion on the same line. That range is
 * the statement's own range in the parse tree, so a comment INSIDE the
 * assertion does not break it -- which it did until #3174, and the run then
 * failed twice over: once for the assertion, once for the marker it said
 * excused nothing. A remedy an instrument prints has to be one it accepts.
 *
 * PROSE IS NOT CODE, and that separation is load-bearing rather than tidy:
 * three unrelated tests mention a `.ts` filename in a comment ("as per
 * `safe-path.test.ts`", "apache-arrow hides the `.d.ts`") while reading a wasm
 * binary or a JSON manifest, and matching those flagged all three. It is the
 * same trap the test this guard was born from fell into -- an assertion that
 * matched its own explanatory comment instead of the code. The detector reads
 * filenames from string and template literals in the tree, so a comment can no
 * longer stand in for one, and a marker is read from comment trivia, so a
 * string can no longer forge one.
 *
 * SCAN SCOPE is packages/, apps/ and scripts/ test files. `scripts/` came in
 * with #3639. Before that this paragraph called its exclusion "a deliberate
 * limit, not an oversight" -- it was an oversight, and a total one: TWO
 * independent barriers hid the tree (scripts/ absent from SEARCH_DIRS, .mjs
 * absent from TEST_FILE_RE), so the whole review lane sat behind both while
 * this gate reported OK. The old paragraph's concern was real, though, and is
 * why the 14 files went to the allowlist rather than being converted: several
 * assert on a gate's OUTPUT through indirect mutator callbacks, where the taint
 * analysis fails closed and a marker would be about output, not source text.
 *
 * `tests/` and `tools/` remain outside. All eight tracked test files there were
 * clean when scripts/ was brought in, so nothing is hidden today -- but it is
 * the same shape of hole, and `tools/**` would also need a row in the frontend
 * CI path filter before a gate there could run.
 *
 * IDENTITY, NOT JUST COUNT (#3664): ALLOWLIST_CEILING is a count, and a count
 * cannot tell "one row removed, a different row added" apart from "nothing
 * changed" -- both leave allowlist.size exactly where it was. A commit that
 * deletes file A's row and adds file B's row in the same change satisfies
 * every check above (B is allowlisted before the "new file" scan runs, A's
 * removal keeps staleAllowlistEntries empty, and the size still equals the
 * ceiling), so B is grandfathered without the ceiling ever moving -- the
 * exact #2531 hole the ceiling was built to close, reopened one level up.
 *
 * The fix compares the CURRENT allowlist against the allowlist at this
 * branch's merge base with origin/main (falling back to local main), the same
 * derivation scripts/check-module-size.mjs uses for its own scoping. A path in
 * the current set that the base set did not have is a NEW exemption, full
 * stop -- identity is the file's path in the allowlist, the same key every
 * other check in this file already uses to correlate a row with a file.
 *
 * A new exemption is only accepted if ALLOWLIST_CEILING rose by at least as
 * many entries as are new, relative to what the constant read at the base
 * commit. That reuses the exact-size-match rule below rather than fighting
 * it: that rule already forces `ceiling(current) - ceiling(base)` to equal
 * `new.length - removed.length` whenever both commits were themselves
 * passing, so the only way to satisfy both a same-size swap's arithmetic
 * (new=1, removed=1, forced ceiling delta 0) and this rule (delta >= 1) is to
 * not do the swap in one change. Splitting it into a removal (ceiling down)
 * and, separately, an addition (ceiling up, with its own review and reason)
 * is not a workaround -- it is the fix: each genuinely new exemption gets its
 * own reviewable ceiling-raise line instead of hiding behind a coincidental
 * offset.
 *
 * MIGRATION: none. No row in the allowlist needs a new field -- the identity
 * key is derived entirely from git history, not stored in the file, so every
 * existing row is already correctly "identified" by the base revision it was
 * already sitting in.
 *
 * DEGRADATION: a merge base is not always resolvable (a shallow local clone,
 * a worktree with no `origin` remote). When it is not, this check prints a
 * WARNING and falls back to the count-only checks above -- it does not error
 * and does not skip silently, because a gate that no-ops when it cannot find
 * a base is the failure mode this repo keeps hitting.
 */

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { analyze } from './source-text-assertion-detect.mjs';

// --root overrides the scanned tree; only the test harness passes it, to point
// this UNMODIFIED script at a synthetic git repository. Production CI and
// local runs take the default -- the real repo root -- exactly as before.
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') out.root = argv[++i];
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));
const ROOT = args.root ? join(args.root) : join(dirname(fileURLToPath(import.meta.url)), '..');
// TWO independent barriers hid the same tree, and fixing either alone changes
// nothing: `scripts/` was never walked, AND `.mjs` was not a test extension.
// Adding the extension first made this guard report the newly-allowlisted files
// as stale entries -- it still could not see them -- which is how the second
// barrier surfaced.
const SEARCH_DIRS = ['packages', 'apps', 'scripts'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'pkg', 'build', 'coverage', '.turbo', 'generated']);
// `.mjs` was absent until #3639, and its absence was total: every test under
// scripts/ is `.test.mjs`, so the entire tree -- the whole review lane included
// -- had never been scanned by this guard. It reported "OK (8 allowlisted, 0
// new)" while its own detector flagged 14 files it never opened. A prohibited
// source-text assertion landed in #3633 and survived eight rounds of hardening
// underneath that green.
const TEST_FILE_RE = /\.(test|spec)\.(ts|tsx|mts|mjs)$/;

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
 * 7 -> 8 (#3018): `packages/data/scripts/generate-ifc-schema.test.ts` is a
 * different KIND of entry from the rest. Every other row is a genuine
 * source-text assertion that cannot yet be written behaviourally. This one is
 * already behavioural — it spawns the generator and asserts on `r.status`,
 * `r.stderr` and `r.stdout`.
 *
 * It is reported because of the OVER-TAINTING this analyser chooses on purpose
 * (`source-text-assertion-detect.mjs`: one flat name set, no scoping, stricter
 * being the safe direction for a ratchet). Bisected rather than guessed: all
 * three hits trace to the single vendored-fixture read, and de-reading it clears
 * every one, while the other two reads clear none. Substituting a literal at
 * each hit site names the carrier — the `.indexOf` pair is carried by `text`,
 * which genuinely holds file bytes and is splicing fixture data, and the
 * `toContain` hit is carried by `message`, a string literal from the
 * parametrised table that shares its name with nothing. NOT by `r.stderr`:
 * replacing that with a literal leaves the hit standing, so this is not a
 * spawn-result false positive.
 *
 * Nothing here asserts on source text, and the analyser is behaving as
 * specified. Two cheaper file-level rules were measured against the rows above
 * and lost coverage (4 of 7 and 3 of 7 caught), so both were rejected rather
 * than shipped for the convenience of one file.
 * Raised in the same commit as the row, which is what this constant forces.
 */
// 8 -> 22. The jump is not new debt: it is 14 files that were always in
// violation and are only now visible, grandfathered in the same commit that
// makes them visible, which is exactly what this constant exists to force. The
// list still only ratchets DOWN from here.
const ALLOWLIST_CEILING = 22;

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

function parseAllowlistText(text) {
  return new Set(
    text
      .split('\n')
      .map((line) => line.replace(/#.*$/, '').trim())
      .filter(Boolean)
  );
}

function loadAllowlist() {
  if (!existsSync(ALLOWLIST_PATH)) return new Set();
  return parseAllowlistText(readFileSync(ALLOWLIST_PATH, 'utf8'));
}

/**
 * This worktree's merge base with origin/main, falling back to local main --
 * identical derivation to scripts/check-module-size.mjs's `changedFiles()`,
 * reused rather than reinvented so the two gates degrade the same way under
 * the same shallow-clone and no-remote conditions.
 *
 * Returns `{ ref, sha }` or `null` if neither ref has a merge base with HEAD
 * (no `origin` remote, or a clone too shallow to share history).
 */
function resolveBase(root) {
  const git = (...argv) => spawnSync('git', ['-C', root, ...argv], { encoding: 'utf8' });
  for (const ref of ['origin/main', 'main']) {
    const merged = git('merge-base', ref, 'HEAD');
    const sha = merged.stdout.trim();
    if (merged.status === 0 && sha !== '') {
      if (ref !== 'origin/main') {
        console.warn(
          `check-source-text-assertions: WARNING -- no merge base with origin/main; fell back ` +
            `to local '${ref}' (${sha.slice(0, 9)}) for the allowlist identity check. If that ` +
            `ref is stale, a swapped-in violation could go undetected this run.`
        );
      }
      return { ref, sha };
    }
  }
  return null;
}

/** `git show <sha>:<relPath>` from `root`, or `null` if the blob is unreadable. */
function readBlobAt(root, sha, relPath) {
  const res = spawnSync('git', ['-C', root, 'show', `${sha}:${relPath}`], { encoding: 'utf8' });
  return res.status === 0 ? res.stdout : null;
}

const allowlist = loadAllowlist();
const offenders = [];
const markedSites = [];
const deadMarkers = [];
const staleAllowlistEntries = new Set(allowlist);

for (const dir of SEARCH_DIRS) {
  for (const file of walk(join(ROOT, dir))) {
    const rel = relative(ROOT, file).split('\\').join('/');
    // The PATH, not just the text: `analyze` parses with TypeScript, and TS
    // and TSX are different grammars -- `<T>(x)` is a type assertion in one and
    // an unclosed JSX tag in the other. Handing it the real name is what makes
    // the parse match the file.
    const result = analyze(readFileSync(file, 'utf8'), rel);
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

// Identity check (#3664): a count cannot tell a swap from an untouched file.
// Compare the current allowlist against the one at this branch's merge base
// -- any path present now that was absent there is a NEW exemption, whether
// or not it was offset by a removal elsewhere in the same change.
let identitySuffix = '';
const base = resolveBase(ROOT);
if (base === null) {
  console.warn(
    'check-source-text-assertions: WARNING -- could not resolve a merge base with ' +
      "origin/main or main; the allowlist identity check is SKIPPED this run. A same-size " +
      'swap (one entry removed, a different one added) would not be caught. Fetch ' +
      'origin/main and re-run for full coverage.'
  );
} else {
  const baseAllowlistText = readBlobAt(ROOT, base.sha, 'scripts/source-text-assertion-allowlist.txt');
  const baseGateText = readBlobAt(ROOT, base.sha, 'scripts/check-source-text-assertions.mjs');
  if (baseAllowlistText === null || baseGateText === null) {
    console.warn(
      `check-source-text-assertions: WARNING -- could not read the allowlist or this gate at ` +
        `${base.ref} (${base.sha.slice(0, 9)}); the identity check is SKIPPED this run.`
    );
  } else {
    const baseAllowlist = parseAllowlistText(baseAllowlistText);
    const baseCeilingMatch = baseGateText.match(/const ALLOWLIST_CEILING = (\d+);/);
    const newEntries = [...allowlist].filter((p) => !baseAllowlist.has(p)).sort();
    if (newEntries.length > 0) {
      const baseCeiling = baseCeilingMatch ? Number(baseCeilingMatch[1]) : null;
      const ceilingRaise = baseCeiling === null ? -Infinity : ALLOWLIST_CEILING - baseCeiling;
      if (ceilingRaise < newEntries.length) {
        failed = true;
        console.error(
          `\nNew allowlist entries not present at the merge base (${base.ref} @ ${base.sha.slice(0, 9)}):\n`
        );
        for (const entry of newEntries) console.error(`  ${entry}`);
        console.error(`
An entry that was not in the allowlist at the merge base is a NEW exemption
from this gate, even when another row was removed in the same change and the
total count did not move. Counting only the size lets a swap grandfather a
brand-new violation invisibly (#3664).

Land the removal and the addition as separate changes: lower ALLOWLIST_CEILING
when you remove a row, and raise it -- by itself, with its own reason --
when you add one. A change that does both at once cannot pass this check by
construction, because the ceiling cannot simultaneously satisfy "must equal
the new total exactly" and "must have room for ${newEntries.length} new
${newEntries.length === 1 ? 'entry' : 'entries'}" unless nothing was removed alongside it.
`);
      }
    }
    identitySuffix = `, identity-checked vs ${base.ref} (${base.sha.slice(0, 9)})`;
  }
}

if (failed) process.exit(1);

for (const site of markedSites) {
  console.log(`  marked @source-text-assertion-ok: ${site}`);
}
console.log(
  `check-source-text-assertions: OK (${allowlist.size} allowlisted, ${markedSites.length} marked, 0 new)${identitySuffix}`
);
