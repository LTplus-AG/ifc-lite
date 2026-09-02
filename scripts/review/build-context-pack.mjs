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

/**
 * What the PR description may claim before the siblings compete for the rest.
 * See the reservation in `buildPack`: without it a large PR starved the body to
 * nothing, and the body is the only evidence for the class of defect where the
 * description and the diff disagree.
 */
export const BODY_RESERVE_BYTES = 8_000;

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
    // Neither is an import line. `@ifc-lite/data` appears in every consumer of
    // that package, so it retrieves the whole dependency graph and crowds the
    // pack with sites that share a dependency rather than an implementation --
    // measured: it took all four top slots and pushed the real sibling out.
    if (/^\s*(import|export)\s|require\(/.test(body)) continue;
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
    if (t.startsWith('@') || t.includes('/')) continue;   // package or path, not an identifier
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
    hits.push({ path, line: Number(num), text: text.trim().slice(0, 120) });
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
    if (h.path.startsWith('packages/')) s += 10;
    if (/^(apps|rust)\//.test(h.path)) s += 5;
    return s;
  };
  hits.sort((a, b) => score(b) - score(a) || a.path.localeCompare(b.path));
  return hits.slice(0, keep);
}

/**
 * Assemble the pack for one PR. Every retrieval happens HERE, in the harness.
 *
 * Priority order is fixed and truncation is recorded, never silent: siblings
 * first because they are the family nothing else catches, then whole-file
 * evidence, then the body. A pack that quietly dropped its most valuable half
 * would look exactly like one that found nothing.
 */
/**
 * Cut `text` to at most `maxBytes` UTF-8 bytes without splitting a character.
 * A plain Buffer slice halves a multi-byte sequence and leaves U+FFFD in the
 * prompt, so the cut is walked back to a character boundary.
 */
export function truncateUtf8(text, maxBytes) {
  if (maxBytes <= 0) return '';
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;
  let end = maxBytes;
  // Continuation bytes are 10xxxxxx; step back off one we landed inside.
  while (end > 0 && (buf[end] & 0b1100_0000) === 0b1000_0000) end -= 1;
  return buf.subarray(0, end).toString('utf8');
}

export function buildPack(input, { baseRef, body = null, cwd = process.cwd(), exec = execFileSync } = {}) {
  const changed = input.files.map((f) => f.path);
  const changedBases = new Set(changed.map((p) => p.split('/').pop()));
  const truncated = [];
  // RESERVED BEFORE THE GREEDY SPENDERS RUN. Siblings are allocated first and
  // take up to forty slots; on a large PR they exhausted the pack, and the PR
  // description -- allocated last -- got the scraps. Measured on pr-3389, whose
  // expected defect IS a contradiction between the description and the diff:
  // 964 bytes of a 12,427-byte body survived, the sentence the defect turns on
  // was not among them, and every file's full content was dropped too. Wiring
  // the body through without this would have fixed the plumbing and left the
  // case exactly as unscoreable.
  //
  // The body is the ONLY evidence for its defect class, and it is cheap. It gets
  // its slice first; siblings and file evidence divide what is left.
  const bodyReserve =
    typeof body === 'string' && body.trim() !== ''
      ? Math.min(BODY_RESERVE_BYTES, Buffer.byteLength(body, 'utf8'))
      : 0;
  let budget = MAX_PACK_BYTES - bodyReserve;

  // GATHER EVERYTHING FIRST, THEN RANK GLOBALLY. Capping in iteration order let
  // low-value hits from an early key crowd out the best hit of a late one --
  // measured: the real #3609 sibling dropped out of the pack entirely because
  // `baseColorFactor` is not the first key in the file. Order of extraction is
  // not order of value.
  const candidates = [];
  const seenKey = new Set();
  for (const f of input.files) {
    for (const key of searchKeys(f.patch, { path: f.path, max: 12 })) {
      if (seenKey.has(key)) continue;
      seenKey.add(key);
      let hits = [];
      try {
        hits = siblingSites(key, changed, baseRef, { cwd, exec, keep: 6 });
      } catch {
        continue;
      }
      // EVERY key that hit this site is kept. De-duplicating here kept whichever
      // key was found FIRST, and `rank` then scored the sibling on that key -- so
      // a five-character token could claim a site and sink it below the cutoff
      // while `resolveHighlightIds` matched the same line and was discarded. The
      // site is collapsed after ranking instead, keeping its best-scoring key.
      for (const h of hits) candidates.push({ ...h, key });
    }
  }
  // Three signals, learned from the five real second-site cases rather than
  // guessed. Ranked by how much each one moved the measurement:
  //
  //   same BASENAME in another package  glb.ts -> glb.ts, a copied module
  //   same DIRECTORY                    scripts/lib/dirty-pr-scan.mjs ->
  //                                     scripts/lib/pr-review-signal.mjs, and
  //                                     measure-unit-scale.ts ->
  //                                     quantity-collect.ts. Neighbours in a
  //                                     directory are the same layer, and a
  //                                     duplicated implementation usually lives
  //                                     one file over rather than one package over
  //   a LONG key                        `getForEntity` and `missingLanes` are
  //                                     claims about a specific function; a
  //                                     five-character token is not
  const changedDirs = new Set(changed.map((p) => p.slice(0, p.lastIndexOf('/'))));
  const rank = (h) => {
    const base = h.path.split('/').pop();
    const dir = h.path.slice(0, h.path.lastIndexOf('/'));
    let s2 = 0;
    if (changedBases.has(base)) s2 += 100;
    if (changedDirs.has(dir)) s2 += 60;
    if (/\.(test|spec)\./.test(base)) s2 -= 50;
    s2 += Math.min(30, h.key.length * 2);
    if (h.path.startsWith('packages/')) s2 += 10;
    return s2;
  };
  candidates.sort((a, b) => rank(b) - rank(a));

  // One row per site, collapsed INSIDE the loop below rather than into a second
  // full-length array. The list is already ranked, so the row kept is still the
  // one whose key scored highest; the filter walked all 14,400 candidates a large
  // PR produces when the consumer reads at most 40 of them.
  const seenSite = new Set();

  const siblings = [];
  for (const h of candidates) {
    const id = `${h.path}:${h.line}`;
    if (seenSite.has(id)) continue;
    seenSite.add(id);
    const cost = Buffer.byteLength(h.text, 'utf8') + 120;
    if (cost > budget || siblings.length >= 40) { truncated.push('sibling excerpts'); break; }
    budget -= cost;
    siblings.push(h);
  }

  const evidence = [];
  for (const f of input.files) {
    const content = showAtRef(input.headSha, f.path, { cwd, exec });
    const e = fileEvidence(f.patch, content);
    if (!e) continue;
    const cost = Buffer.byteLength(e.text, 'utf8') + 80;
    if (cost > budget) { truncated.push(`full content of ${f.path}`); continue; }
    budget -= cost;
    evidence.push({ path: f.path, ...e });
  }

  let packBody = null;
  // `bodyReserve > 0` holds exactly when the reservation above fired. Restating
  // the predicate meant two copies of one rule that must not drift: change what
  // counts as a blank body in one place and the pack either reserves bytes it
  // never spends or spends bytes it never reserved, with nothing observing it.
  if (bodyReserve > 0) {
    // BY BYTES, like every other budget here. `slice` counts UTF-16 code units,
    // so a description of 4,000 emoji passed an 8,000-"byte" check at 16,000
    // actual bytes and the pack could exceed MAX_PACK_BYTES.
    // ITS RESERVE, AND NOTHING MORE. This was `bodyReserve + budget`, which
    // handed the body every byte siblings and evidence had not spent: on a small
    // PR with a long description that measured 159,908 bytes of author-written
    // prose in a 160,000-byte pack, with the diff and the retrieved siblings
    // rounding to nothing. A reservation is a floor; it must not also be a claim
    // on the remainder, least of all for the one input this file calls untrusted.
    const trimmed = truncateUtf8(body, bodyReserve);
    if (trimmed) packBody = trimmed;
    if (trimmed.length < body.length) truncated.push('PR description');
  }

  return { siblings, fileEvidence: evidence, body: packBody, truncated: [...new Set(truncated)] };
}
