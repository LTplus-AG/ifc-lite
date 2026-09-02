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

/**
 * The ceiling on EVERYTHING the reviewer is handed: diff plus pack.
 *
 * The pack was originally added on top of the 600 KB patch cap, which moved the
 * real bound to 760 KB -- past a 200k-token window at this repo's measured ~3.5
 * bytes per token, whose failure mode is a MODEL_ERROR with no path to a marker.
 *
 * The first fix charged the pack against the patch budget instead, cutting the
 * diff allowance to 454,400 bytes. That was worse: the largest PR observed here
 * is ~427 KB, 96% of the new cap, so a PR the lane used to review would start
 * throwing REVIEW_TOO_LARGE -- and `claude-review.yml` special-cases only
 * NO_FILES, so the job goes red with NO marker, which no re-run and no author
 * action can clear. Fixing a token ceiling by making the lane refuse work it
 * used to do is not a fix.
 *
 * So the DIFF keeps its full allowance and the PACK yields. A small PR gets the
 * whole pack; a near-maximal diff gets whatever is left. The pack is the
 * optional half, and it already records everything it drops.
 */
export const MAX_PROMPT_BYTES = 700_000;

/**
 * Everything in the prompt that is neither diff nor pack: the rubric (~10.6 KB),
 * a `--- FILE: <path>` header per file, the fence markers, the section prose and
 * the unreviewable list.
 *
 * Without this reserve the ceiling above bounded two of the prompt's four terms
 * and called itself "the ceiling on EVERYTHING the reviewer is handed". Measured
 * with the real `buildPrompt` and rubric: a 1,000-file, 608,000-byte diff
 * produced a 765,620-byte prompt. The arithmetic test could not catch it --
 * `maxDiff + packBudgetFor(maxDiff) <= MAX_PROMPT_BYTES` is true by construction
 * and never touches `buildPrompt`. The test that replaces it builds a real
 * prompt and measures it.
 */
export const PROMPT_BASE_OVERHEAD_BYTES = 24_000;

/**
 * Per changed file: its `--- FILE: <path>` header, fences, and the entry in the
 * files-reviewed list. Headers dominate the envelope on a large PR -- a flat
 * reserve of 60,000 left a 1,000-file diff 8,050 bytes over the ceiling, which
 * the measured test caught and the arithmetic one never could.
 */
export const PROMPT_PER_FILE_BYTES = 70;

/** What the pack may spend once the diff has taken its share. */
export function packBudgetFor(patchBytes, fileCount = 0) {
  const envelope = PROMPT_BASE_OVERHEAD_BYTES + Math.max(0, fileCount || 0) * PROMPT_PER_FILE_BYTES;
  const room = MAX_PROMPT_BYTES - envelope - (patchBytes || 0);
  return Math.max(0, Math.min(MAX_PACK_BYTES, room));
}

/** How many "omitted for size" notes the pack will list before summarising. */
export const MAX_TRUNCATION_NOTES = 20;

/** Bytes charged per whole-file evidence entry on top of its text. */
export const FILE_ENTRY_OVERHEAD = 80;

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
 * A GLOBAL CEILING ON KEYS, not on greps.
 *
 * Sibling search costs one `git grep` per key, and key count scales with file
 * count, so an unbounded PR is an unbounded number of subprocesses. The cap is
 * global rather than per-file and what it drops is RECORDED, because a retrieval
 * that quietly searched half the diff is the failure this module exists to make
 * impossible.
 */
export const MAX_SEARCH_KEYS = 150;

/**
 * Sites matching one key that this PR did NOT change.
 *
 * ONE GREP PER KEY, and that is deliberate after measuring the alternative.
 * A batched `git grep -e k1 -e k2 ...` looks obviously cheaper -- one process
 * instead of N -- and is dramatically worse, because git's fixed-string matcher
 * degrades superlinearly in pattern count. Measured on this repo with the real
 * key set `searchKeys` produces:
 *
 *   keys   per-key loop   one batched grep
 *     10        748 ms           2,026 ms
 *     25      1,832 ms           5,615 ms
 *     54      3,955 ms          26,020 ms
 *
 * The batch was written against a figure of "274 keys, 22.9 seconds, ~79 ms
 * each" that had been measured on a SHALLOW checkout, where every grep exited in
 * milliseconds having found nothing. It timed the bug, not the work. Batching
 * also broke retrieval three ways: attribution ran against a 120-char-truncated
 * line so hits with the key past column 120 were dropped, the per-key `keep` cap
 * became a cap on a partition so crowded-out sites vanished, and one shared
 * maxBuffer meant an overflow silently returned zero siblings.
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
      { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return [];                       // exit 1 means no matches, which is normal
  }
  return rankHits(parseGrep(out, changedPaths), changedPaths).slice(0, keep);
}

/** Hits from `git grep <ref>` output, minus the paths a sibling is never in. */
function parseGrep(out, changedPaths) {
  const changed = new Set(changedPaths);
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

  return hits;
}

/** Rank by shape, never by rarity. */
function rankHits(hits, changedPaths) {
  const changedBases = new Set(changedPaths.map((p) => p.split('/').pop()));
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
  return [...hits].sort((a, b) => score(b) - score(a) || a.path.localeCompare(b.path));
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

/**
 * Did retrieval fail outright, as opposed to finding nothing?
 *
 * Siblings can legitimately be zero -- a PR of genuinely new code has none. But
 * every reviewable PR has at least one changed file whose content
 * `git show <headSha>:<path>` can return, so zero file evidence across a
 * non-empty diff means the refs are not reachable, not that the diff is small.
 *
 * It lives here because this module owns the retrieval that swallows the exit
 * 128, and it is shared because the eval calls `buildPack` directly: a warning
 * wired into only one of two callers leaves the other scoring a pack that was
 * never assembled, which is the exact failure this whole change exists to end.
 */
export function retrievalFailed(pack, changedFileCount) {
  if (changedFileCount === 0) return false;
  // NOT WHEN THE BUDGET ATE IT. File evidence is also dropped for size, so a PR
  // whose files are all large yields zero evidence on a perfectly healthy
  // checkout -- and the warning would then tell its author to set fetch-depth: 0,
  // which is a remedy for a problem they do not have. A budget drop always leaves
  // a note behind; a missing ref never does.
  const droppedForSize = pack.truncated.some((t) => t.startsWith('full content of') || t.startsWith('and '));
  return pack.fileEvidence.length === 0 && !droppedForSize;
}

export function retrievalFailedMessage(headSha, fileCount) {
  return (
    `NO file evidence was retrievable for any of the ${fileCount} changed file(s). That is not an ` +
    `empty diff -- \`git show ${String(headSha).slice(0, 9)}:<path>\` returned nothing for every one ` +
    'of them, which means those refs are not in the object database.'
  );
}

/**
 * The LANE's remedy, and only the lane's. It used to be one shared constant
 * ending "REMEDY: set fetch-depth: 0" -- which the eval printed on every run,
 * eight lines below a workflow comment recording that full history buys the eval
 * nothing (0 of 18 case head shas are reachable at any depth). A remedy that
 * contradicts its own finding is worse than none.
 */
export const SHALLOW_CHECKOUT_REMEDY =
  'On CI this almost always means the checkout is shallow: actions/checkout defaults to ' +
  'fetch-depth: 1, and a pull_request event fetches only refs/pull/N/merge. REMEDY: set ' +
  'fetch-depth: 0.';


export function buildPack(input, { baseRef, body = null, patchBytes = 0, cwd = process.cwd(), exec = execFileSync } = {}) {
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
      ? Math.min(BODY_RESERVE_BYTES, Buffer.byteLength(body, 'utf8'), packBudgetFor(patchBytes, input.files.length))
      : 0;
  let budget = packBudgetFor(patchBytes, input.files.length) - bodyReserve;

  // GATHER EVERYTHING FIRST, THEN RANK GLOBALLY. Capping in iteration order let
  // low-value hits from an early key crowd out the best hit of a late one --
  // measured: the real #3609 sibling dropped out of the pack entirely because
  // `baseColorFactor` is not the first key in the file. Order of extraction is
  // not order of value.
  const candidates = [];
  const seenKey = new Set();
  for (const f of input.files) {
    for (const key of searchKeys(f.patch, { path: f.path, max: 12 })) {
      seenKey.add(key);
    }
  }
  // THE CAP IS GLOBAL AND ITS LOSS IS RECORDED. A per-file cap let later files in
  // a large PR contribute nothing while the pack reported no omission, which is a
  // retrieval that quietly searched half the diff.
  const searched = [...seenKey].slice(0, MAX_SEARCH_KEYS);
  if (seenKey.size > searched.length) {
    truncated.push(`sibling search for ${seenKey.size - searched.length} further key(s)`);
  }
  const byKey = new Map();
  for (const key of searched) {
    let hits = [];
    try {
      hits = siblingSites(key, changed, baseRef, { cwd, exec, keep: 6 });
    } catch {
      continue;
    }
    if (hits.length > 0) byKey.set(key, hits);
  }
  // EVERY key that hit a site is kept here. De-duplicating during collection kept
  // whichever key was found FIRST, and `rank` then scored the sibling on that key
  // -- so a five-character token could claim a site and sink it below the cutoff
  // while `resolveHighlightIds` matched the same line and was discarded. Sites
  // are collapsed after ranking instead, keeping each one's best-scoring key.
  for (const [key, hits] of byKey) {
    for (const h of hits) candidates.push({ ...h, key });
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
    // STOP SPAWNING ONCE NOTHING CAN FIT. `showAtRef` is a subprocess per file
    // and the loop `continue`s past a file too large for the remaining budget --
    // so a 1,000-file PR ran 1,000 `git show` calls, at ~66 ms each, long after
    // the budget could hold anything. Below the per-entry overhead nothing can
    // fit however small the file is.
    if (budget <= FILE_ENTRY_OVERHEAD) { truncated.push('full content of the remaining files'); break; }
    const content = showAtRef(input.headSha, f.path, { cwd, exec });
    const e = fileEvidence(f.patch, content);
    if (!e) continue;
    const cost = Buffer.byteLength(e.text, 'utf8') + FILE_ENTRY_OVERHEAD;
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

  // CAPPED. `truncated` is rendered into the prompt but was never charged against
  // the budget, and it grows precisely when the pack is already full: a 500-file
  // PR whose evidence is all dropped adds one line per file, ~25 KB, to a pack
  // whose whole contract is a 160 KB ceiling.
  // No dedup: the four pushes into `truncated` are one break-guarded sibling
  // note, one key-cap note, one per changed path (each listed once), and one
  // description note. A Set removed nothing and implied duplicates were possible.
  // THE DESCRIPTION NOTE SURVIVES THE CAP. `truncated` is appended in order --
  // siblings, then one note per dropped file, then the body -- so on a large PR
  // the body's note fell outside the first twenty and was replaced by "and N
  // more". That note is the reviewer's ONLY signal that the description was cut,
  // and it went missing on exactly the PRs where cutting happens, leaving a "the
  // description says X" claim to be made against a truncated description.
  const BODY_NOTE = 'PR description';
  const rest = truncated.filter((t) => t !== BODY_NOTE);
  const shown = rest.slice(0, MAX_TRUNCATION_NOTES);
  if (rest.length > shown.length) shown.push(`and ${rest.length - shown.length} more`);
  if (truncated.includes(BODY_NOTE)) shown.push(BODY_NOTE);
  return { siblings, fileEvidence: evidence, body: packBody, truncated: shown };
}
