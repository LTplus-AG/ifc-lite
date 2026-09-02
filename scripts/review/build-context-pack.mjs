/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The evidence the reviewer needs that a diff does not contain.
 *
 * MEASURED, not assumed. Encoding one day's twelve merge-blocking defects as
 * eval cases and running the current lane over them scored 1/15. The one it
 * found was the only defect fully visible inside the diff. The other eleven are
 * invisible by construction:
 *
 *   second-site (5)   needs the sibling the PR did NOT touch
 *   count-distortion, dedup-merges-distinct, absence-reads-as-success (4)
 *                     need the whole function, not the hunk
 *   bump-too-low (2)  needs the changeset text and the API surface
 *   body-diff-mismatch (1)  needs the PR body, which the input builder strips
 *
 * So this is not a prompt problem and no rubric wording recovers it. The lane
 * was starved.
 *
 * THE MODEL STILL GETS NO ENGINE. Every retrieval here runs in this trusted
 * script; the reviewer remains a pure function over text, one turn, no tools,
 * empty MCP, empty cwd. That is the whole security position and this file does
 * not move it.
 *
 * The one rule that keeps it true: NO TOOL THAT READS CONFIGURATION EVER RUNS
 * OVER PR-HEAD CONTENT, AND THE PR HEAD IS NEVER CHECKED OUT INTO A WORKING
 * TREE IN THE REVIEW JOB. `git show <sha>:<path>` writes to stdout, so no PR
 * file lands on disk where a config-autoloading tool could find it. That is the
 * exact lesson of the CodeRabbit RCE: a `rubocop.yml` carried in a PR, executed
 * by a linter that autoloads config, reached write access on a million repos.
 *
 * Everything assembled here is UNTRUSTED and is fenced by run-reviewer.mjs
 * alongside the diff. Base-branch content is merged, reviewed text and is
 * lower risk than the head, but it is fenced the same way: the fence is cheap
 * and a carve-out is a thing to get wrong later.
 */

import { execFileSync } from 'node:child_process';

/** Total pack budget. Truncation is recorded, never silent. */
export const MAX_PACK_BYTES = 160_000;
/** A file longer than this is windowed around its hunks instead of sent whole. */
export const MAX_WHOLE_FILE_LINES = 1_500;
/** Lines of context either side of a hunk when windowing. */
export const HUNK_WINDOW_LINES = 80;

export class ContextPackError extends Error {
  constructor(reason, message) {
    super(message);
    this.reason = reason;
  }
}

/**
 * `git show <ref>:<path>` to STDOUT. Never a checkout, never a working tree.
 *
 * Returns null when the path does not exist at that ref, which is the normal
 * case for a file the PR adds and is not an error.
 */
export function showAtRef(ref, path, { cwd = process.cwd(), exec = execFileSync } = {}) {
  if (!/^[0-9a-f]{40}$/.test(String(ref)) && !/^[\w./-]+$/.test(String(ref))) {
    throw new ContextPackError('BAD_REF', `refusing a ref that is not a sha or a plain name: ${ref}`);
  }
  try {
    return exec('git', ['show', `${ref}:${path}`], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return null;
  }
}

/** New-file line numbers a patch touches, so a long file can be windowed. */
export function hunkLines(patch) {
  const out = [];
  let n = 0;
  for (const line of String(patch).split(/\r?\n/)) {
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (h) { n = Number(h[1]); continue; }
    if (line.startsWith('\\')) continue;
    if (line.startsWith('+') && !line.startsWith('+++')) { out.push(n); n += 1; }
    else if (line.startsWith('-') && !line.startsWith('---')) { /* no new line */ }
    else n += 1;
  }
  return out;
}

/**
 * The changed file as it will exist after merge, whole when it is small enough
 * and windowed around the hunks when it is not.
 *
 * This is what makes count-distortion and dedup-merges-distinct findable: those
 * defects are in the function, not in the hunk. A reviewer shown eight added
 * lines cannot see that the filter it just read also feeds a count computed
 * forty lines below.
 */
export function fileEvidence(patch, content) {
  if (content == null) return null;
  const lines = content.split('\n');
  if (lines.length <= MAX_WHOLE_FILE_LINES) {
    return { kind: 'whole', from: 1, to: lines.length, text: content };
  }
  const touched = hunkLines(patch);
  if (touched.length === 0) return null;
  const lo = Math.max(1, Math.min(...touched) - HUNK_WINDOW_LINES);
  const hi = Math.min(lines.length, Math.max(...touched) + HUNK_WINDOW_LINES);
  return { kind: 'window', from: lo, to: hi, text: lines.slice(lo - 1, hi).join('\n') };
}

/**
 * ============================ SECOND-SITE RETRIEVAL ==========================
 *
 * The largest defect family here, five of twelve, and the one nothing on the
 * market catches. Running the CodeRabbit CLI over three of these five cases
 * found the sibling in none of them: one returned "No findings", one a minor
 * test nit, one a real but unrelated key-collision bug. That is not a knock on
 * it -- it is evidence that diff-scoped review, however good, cannot answer a
 * question about a file it was never asked to open.
 *
 * The shape of the defect: the PR changed pattern P at site A, and P survives
 * unchanged at site B. Every time it has bitten this repo, B was the PUBLISHED
 * site and the PR's own tests could not see it -- two GLB importers, two
 * `getForEntity` copies, three query backends.
 *
 * So the search keys come from the diff itself, and the strongest ones come
 * from the REMOVED lines: whatever the PR deleted at A is, by definition, still
 * present at B. Added-line identifiers are weaker but catch a widened check.
 *
 * Searched against the BASE tree, never the head. The sibling is untouched, so
 * base and head agree on it, and base content is merged and reviewed -- the
 * lower-risk half of an already-fenced input.
 */

/** Identifiers and literals worth searching for. Longer is more distinctive. */
export function searchKeys(patch, { path = '', max = 12 } = {}) {
  // PROSE EATS THE BUDGET. The first version took the first ten tokens of five
  // or more characters, and on two real cases every one of them came from the
  // MPL licence header -- "Source, subject, terms, Mozilla, Public, License" --
  // or from changeset markdown. The identifiers that actually find the sibling
  // (`missingLanes`, `siScale`, `baseColorFactor`) never got a slot.
  //
  // So: markdown carries no implementation, and a key has to LOOK like code.
  if (/\.(md|txt|snap|lock)$/.test(path)) return [];

  const isIdentifier = (t) =>
    /[a-z][A-Z]/.test(t) ||          // camelCase
    /^[A-Z][a-z]+[A-Z]/.test(t) ||   // PascalCase
    /_/.test(t) ||                   // snake_case / SCREAMING_CASE
    /^[a-z]+[0-9]/.test(t);          // trailing digits

  const removed = [];
  const added = [];
  for (const line of String(patch).split(/\r?\n/)) {
    if (line.startsWith('---') || line.startsWith('+++')) continue;
    const bucket = line.startsWith('-') ? removed : line.startsWith('+') ? added : null;
    if (!bucket) continue;
    const body = line.slice(1);
    // Licence headers and comment prose are not evidence of a second site.
    if (/^\s*(\/\*|\*|\/\/|#)/.test(body)) continue;
    for (const m of body.matchAll(/[A-Za-z_$][A-Za-z0-9_$]{4,}/g)) bucket.push(m[0]);
    for (const m of body.matchAll(/'([^'\n]{6,60})'|"([^"\n]{6,60})"/g)) bucket.push(m[1] ?? m[2]);
  }

  // Removed lines first: whatever this PR deleted at site A is, by definition,
  // still sitting at site B.
  const seen = new Set();
  const strong = [];
  const weak = [];
  for (const raw of [...removed, ...added]) {
    const t = String(raw).trim();
    if (t.length < 5 || seen.has(t)) continue;
    if (/^(const|return|function|import|export|require|string|number|boolean|undefined|null|true|false|class|interface|extends|public|license|Mozilla|Source)$/i.test(t)) continue;
    seen.add(t);
    (isIdentifier(t) ? strong : weak).push(t);
  }
  return [...strong, ...weak].slice(0, max);
}

/**
 * Sites matching a key that this PR did NOT change.
 *
 * A key appearing everywhere proves nothing, so anything over `maxHits` is
 * dropped as non-distinctive rather than truncated -- truncating would leave
 * the reviewer a biased sample of a common token and invite a confident wrong
 * claim about "the other site".
 */
export function siblingSites(key, changedPaths, ref, { cwd = process.cwd(), exec = execFileSync, keep = 6 } = {}) {
  // `git grep <pattern> <ref>` searches that COMMIT'S TREE. No working tree, no
  // checkout, no dependency on ripgrep being installed on the runner. It also
  // makes the security posture stricter rather than weaker: the base tree is
  // read out of the object database, so there is never a moment where PR
  // content sits on disk for a config-autoloading tool to find.
  let out;
  try {
    out = exec('git', ['grep', '-n', '--fixed-strings', '--no-color', '-I', '-e', key, ref],
      { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  } catch {
    return [];                       // exit 1 means no matches, which is normal
  }
  const changed = new Set(changedPaths);
  const changedBases = new Set([...changed].map((p) => p.split('/').pop()));
  const hits = [];
  for (const line of out.split('\n')) {
    // `git grep <ref>` prefixes every hit with `<ref>:`
    const m = /^[^:]+:(.+?):(\d+):(.*)$/.exec(line);
    if (!m) continue;
    const [, path, num, text] = m;
    if (changed.has(path)) continue;
    if (/^(node_modules|dist|pkg|build|coverage)\//.test(path)) continue;
    if (/(^|\/)(__fixtures__|__snapshots__|eval-cases)\//.test(path)) continue;
    // CHANGELOGs mention every identifier the package ever shipped and are
    // not a second implementation of anything.
    if (/(^|\/)(CHANGELOG\.md|.*\.changeset\/)/.test(path)) continue;
    if (/\.(md|txt|json|lock|snap)$/.test(path)) continue;
    hits.push({ path, line: Number(num), text: text.trim().slice(0, 200) });
  }

  // RANK, DO NOT DISCARD. The first version dropped any key with more than
  // eight hits as "not distinctive", and that rule threw away the exact key
  // that finds the real #3609 sibling: `baseColorFactor` has 33 hits across 17
  // files, and one of them is the unfixed published importer. Commonness is not
  // the signal; SHAPE is.
  //
  // Strongest signal by a distance: a file with the SAME BASENAME as one the PR
  // changed, in a different package. packages/cache/src/glb.ts changed and
  // packages/export/src/glb.ts is the twin -- that is what a copied module
  // looks like on disk. Tests rank last: a hit in a test proves the key is
  // used, not that a second implementation exists.
  const score = (h) => {
    const base = h.path.split('/').pop();
    let s = 0;
    if (changedBases.has(base)) s += 100;
    if (/\.(test|spec)\./.test(base)) s -= 50;
    if (/^packages\//.test(h.path)) s += 10;
    if (/^(apps|rust)\//.test(h.path)) s += 5;
    return s;
  };
  hits.sort((a, b) => score(b) - score(a) || a.path.localeCompare(b.path));
  return hits.slice(0, keep);
}
