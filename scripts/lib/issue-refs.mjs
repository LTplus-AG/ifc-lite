/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/**
 * The accepted secondary shape for `scripts/check-issue-queue.mjs` (#4147):
 * a PR that REFERENCES a `ready` issue with a non-closing keyword, instead of
 * falsely claiming `Closes`, still passes the gate.
 *
 * WHY THIS EXISTS. `closingIssuesReferences` -- the gate's primary and
 * preferred signal -- is populated ONLY by a closing keyword (Closes/Fixes/
 * Resolves and their synonyms). A PR that is deliberately a SLICE of a larger
 * issue cannot honestly use one of those without also claiming to finish work
 * it did not finish, and `closingIssuesReferences` auto-closes the issue at
 * merge time. Five PRs hit this on 2026-09-08 in one evening, all correctly
 * refusing to lie, all needing a manual `unqueued` waiver that says the
 * opposite of the truth (`unqueued` means "did not need to wait for the
 * queue"; the truth was "waited, was approved, is proceeding in slices").
 *
 * WHY A BODY REGEX IS SAFE HERE WHEN IT WAS REJECTED FOR THE CLOSING CASE.
 * `check-issue-queue.mjs`'s own header (PART 1) explains at length why a body
 * regex must never stand in for `closingIssuesReferences`: GitHub's own
 * keyword scanner has no notion of negation, and #2978 proved a body regex
 * disagrees with the real link in both directions. That argument is about
 * REPLACING the authoritative field. This module does not replace it -- a PR
 * that closes a `ready` issue still passes on that alone, before any of this
 * runs. What follows is consulted ONLY when `closingIssuesReferences` closes
 * nothing, and it can only WIDEN a fail into a pass, never narrow a pass into
 * a fail, and only for issues independently confirmed OPEN and `ready` by the
 * gate's normal, authorised-applier label check. A false positive here costs
 * nothing worse than a PR that should have needed `unqueued` instead getting a
 * pass it was already one label away from -- not an issue closing itself out
 * from under a sentence that denied it.
 *
 * THE KEYWORD SET is deliberately narrow and deliberately NOT the GitHub
 * closing set: `Refs`, `References`, `Part of`, `Towards` (all case
 * insensitive). Anything using `Closes`/`Fixes`/`Resolves` is already read
 * from `closingIssuesReferences` and never reaches this module.
 *
 * A MATCH REQUIRES INTENT, NOT JUST THE WORD. A body regex over free text
 * finds `Refs #12` wherever the four letters happen to sit -- inside a
 * fenced code block quoting someone else's commit message, inside an inline
 * code span, inside a `>` quoted reply, or as an ordinary verb ("this
 * function refs #12 in a loop"). None of those carry the author's intent to
 * name a queue entry, and because this module can only WIDEN a fail into a
 * pass (see above), a match with no intent behind it is not a conservative
 * false positive -- it is a live bypass of the entire queue gate for ANY PR
 * that happens to quote a `ready` issue number in a code sample or a reply.
 * `stripNonProse` removes the three container shapes that are never intent
 * (fence / span / quote) and `REF_KEYWORD_RE` then requires the keyword to
 * START its line (optionally after a list marker), which is how every real
 * `Refs #N` in this repo is actually written and which also rejects the
 * mid-sentence verb case without a second special rule for it.
 *
 * NOT A MARKDOWN PARSER. This is a scoped pre-pass, matching the gate's own
 * convention of staying dependency-light: it recognises exactly the three
 * shapes above by their line-level markers, not the full CommonMark grammar
 * (a markdown link's display text, for instance, is left alone -- narrower
 * scope than "ignore everything that isn't plain prose" but enough to close
 * the confirmed hole without a new dependency).
 */

/**
 * Strips the three markdown container shapes that never carry authorial
 * intent for a reference, so `REF_KEYWORD_RE` never sees inside them:
 *
 *  - fenced code blocks, ``` or ~~~, across lines
 *  - inline code spans, `single backticks`
 *  - blockquote lines, optional leading whitespace then `>`
 *
 * Replaces stripped text with spaces (fences/spans) or blanks out the whole
 * line (blockquotes) rather than deleting it, so line boundaries -- which
 * `REF_KEYWORD_RE`'s `^` anchor depends on -- are preserved exactly; nothing
 * downstream of a strip can accidentally glue two lines into one that now
 * starts with a keyword it never did.
 *
 * @param {string} body
 * @returns {string}
 */
// A ``` or ~~~ fence, factored out so `findNearMissRefIssueNumbers` can reuse
// just this step of `stripNonProse`.
function stripFencedCode(body) {
  return body.replace(/^([ \t]*)(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1\2[ \t]*$/gm, (m) =>
    m.replace(/[^\n]/g, ' '),
  );
}

// Exported for scripts/lib/partial-close-admission.mjs (#4154), which needs
// the fenced-code/inline-span stripping (NOT the blockquote step below)
// before its own admission-phrase scan, for the same reason this module
// needs it before `REF_KEYWORD_RE`: a `Closes #N (item 1 only)` quoted
// inside a code fence or an inline span is not the PR author's own claim --
// it is someone else's text (a commit message, an example) the author is
// merely showing. That reasoning does NOT extend to a blockquote; see that
// module's header for why it deliberately does not call this function.
export function stripCode(body) {
  let out = stripFencedCode(body);
  // Inline code spans: `...` on a single line. Markdown inline code never
  // spans a blank line, and stopping at `\n` keeps this from ever eating a
  // later, unrelated line if a stray unmatched backtick appears.
  out = out.replace(/`[^`\n]*`/g, (m) => ' '.repeat(m.length));
  return out;
}

export function stripNonProse(body) {
  let out = stripCode(body);
  // Blockquote lines: blank the whole line when its first non-whitespace
  // character is `>`, so a quoted `Refs #12` -- including a quoted reply
  // that itself contains a fenced block -- never reaches the keyword regex.
  out = out.replace(/^[ \t]*>.*$/gm, (m) => ' '.repeat(m.length));
  return out;
}

/**
 * Matches `Refs #12`, `References #12`, `Part of #12`, `Towards #12` (any
 * case, with or without a colon), only where the keyword STARTS its line --
 * optionally after a list marker (`- `, `* `, `+ `, `1. `, `1) `) -- which is
 * how a real reference is actually written in a PR body and which also
 * rejects the "refs" used as an ordinary verb mid-sentence.
 */
export const REF_KEYWORD_RE =
  /^[ \t]*(?:[-*+]\s+|\d+[.)]\s+)?(?:refs?|references?|part of|towards?)[:\s]+#(\d+)/gim;

/**
 * The distinct issue numbers a PR body names with a non-closing keyword, in
 * first-seen order. Never throws: an absent or malformed body is simply "no
 * references", not a gate refusal -- the field is advisory input to a WIDENING
 * check, not evidence a missing read must fail closed over.
 *
 * Runs `stripNonProse` first so a fenced code block, inline code span, or
 * blockquoted line can never supply a match -- see the module header for why
 * a match with no authorial intent behind it is a live bypass, not a
 * harmless false positive.
 *
 * @param {unknown} body
 * @returns {number[]}
 */
export function extractRefIssueNumbers(body) {
  if (typeof body !== 'string' || body === '') return [];
  const prose = stripNonProse(body);
  const seen = new Set();
  const out = [];
  const re = new RegExp(REF_KEYWORD_RE.source, REF_KEYWORD_RE.flags);
  let m;
  while ((m = re.exec(prose)) !== null) {
    const n = Number(m[1]);
    if (Number.isInteger(n) && n > 0 && !seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  return out;
}

// The permissive shape `REF_KEYWORD_RE` (#4147) stopped matching: a keyword +
// `#N` ANYWHERE, not just at line start. Cosmetic-only, never the verdict.
const NEAR_MISS_REF_RE = /(?:refs?|references?|part of|towards?)[:\s]+#(\d+)/gim;

// Numbers named with a keyword in a shape `REF_KEYWORD_RE` rejects (numbers
// it DID accept are excluded -- their format was fine). Strips only fenced
// code, not the full `stripNonProse`: a fence is the confirmed exploit shape
// ("move it out of the fence" would help an attacker), but a backtick-wrapped
// or blockquoted mid-sentence mention is the honest near-miss this catches.
export function findNearMissRefIssueNumbers(body) {
  if (typeof body !== 'string' || body === '') return [];
  const accepted = new Set(extractRefIssueNumbers(body));
  const seen = new Set();
  for (const m of stripFencedCode(body).matchAll(NEAR_MISS_REF_RE)) {
    const n = Number(m[1]);
    if (Number.isInteger(n) && n > 0 && !accepted.has(n)) seen.add(n);
  }
  return [...seen];
}

// A REMEDY hint for NO_LINKED_ISSUE: the body names a keyword + issue number
// in a shape the gate doesn't accept. Cosmetic-only -- called from inside
// the failure-message branch, never used to decide `ok`/`verdict`.
export function nearMissRefsNote(nearMissNumbers) {
  if (nearMissNumbers.length === 0) return [];
  const nums = nearMissNumbers.map((n) => `#${n}`).join(', ');
  return [
    `   This PR's body mentions ${nums} with a reference keyword, but not in a form this gate ` +
      'accepts. REMEDY: put `Refs #N` at the start of its own line, optionally after a list ' +
      'marker (`-`, `*`, `+`, `1.`).',
  ];
}

/**
 * A GraphQL query reading one issue per referenced number, aliased `r0`, `r1`,
 * ... in call order. Each field mirrors a `closingIssuesReferences` node
 * exactly (state, labels, the LabeledEvent timeline) so the SAME `labelSet` /
 * `timelineOf` / `adjudicateLabel` machinery the gate already trusts for a
 * closing link applies unchanged to a referenced one -- no second code path
 * to keep in sync with the first.
 *
 * `issue(number:N)` takes N embedded in the query text rather than as a
 * GraphQL variable, because the count of referenced issues varies per PR and
 * GraphQL has no array-of-aliases construct. This is safe ONLY because `N`
 * is guaranteed to be the digits `extractRefIssueNumbers` itself captured
 * (`\d+`) -- never untrusted text spliced in some other way.
 *
 * @param {number[]} numbers
 */
export function buildRefsQuery(numbers) {
  const fields = numbers
    .map(
      (n, i) => `      r${i}: issue(number:${n}) {
        number title state
        labels(first:100) { pageInfo { hasNextPage } nodes { name } }
        timelineItems(last:100, itemTypes:[LABELED_EVENT]) {
          pageInfo { hasPreviousPage }
          nodes { ... on LabeledEvent { label { name } actor { login } createdAt } }
        }
      }`,
    )
    .join('\n');
  return `query($owner:String!, $name:String!) {
  repository(owner:$owner, name:$name) {
${fields}
  }
}`;
}

/**
 * The raw `gh api graphql` payload for `buildRefsQuery(numbers)` into the same
 * `{ [number]: node | null }` shape whether the read came from a live call or
 * a `--state-file` fixture, so `normalisePullRequest` in the gate never has to
 * know which. `null` means GitHub itself said "no such issue" -- a stray
 * `Refs #999999` is not evidence of anything and is not a refusal.
 *
 * @param {unknown} payload
 * @param {number[]} numbers
 * @returns {Record<string, unknown>}
 */
export function mapRefsPayload(payload, numbers) {
  const repo = payload?.data?.repository;
  /** @type {Record<string, unknown>} */
  const out = {};
  numbers.forEach((n, i) => {
    out[String(n)] = repo && typeof repo === 'object' ? (repo[`r${i}`] ?? null) : null;
  });
  return out;
}

/**
 * Fetch referenced issues with a `gh` call injected (default: a live
 * `spawnSync`), fail-closed through the caller's `fail(reason, message)`
 * -- the same pattern `existsOrThrow` uses -- so this module never has to
 * import `IssueQueueError` and the gate never has to import a second error
 * type. Called ONLY when `closingIssuesReferences` closed nothing and the
 * body named at least one candidate, so an ordinary PR that closes its issue
 * pays no extra round trip and cannot be failed by this path at all.
 *
 * @param {{ repo: string, numbers: number[], spawn: typeof import('node:child_process').spawnSync, fail: (reason: string, message: string) => never }} opts
 */
export function fetchRefsPayload({ repo, numbers, spawn, fail }) {
  if (numbers.length === 0) return {};
  const slash = repo.indexOf('/');
  const args = [
    'api',
    'graphql',
    '-f',
    `query=${buildRefsQuery(numbers)}`,
    '-f',
    `owner=${repo.slice(0, slash)}`,
    '-f',
    `name=${repo.slice(slash + 1)}`,
  ];
  const r = spawn('gh', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (r.error) {
    fail(
      'GH_UNAVAILABLE',
      `Could not spawn \`gh\` to read referenced issue(s) ${numbers.join(', ')}: ${r.error.message}.`,
    );
  }
  let parsed = null;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    parsed = null;
  }
  const errors = parsed && Array.isArray(parsed.errors) ? parsed.errors : null;
  if (errors && errors.length > 0) {
    fail(
      'GRAPHQL_ERRORS',
      `GitHub's GraphQL API returned ${errors.length} error(s) reading referenced issue(s) ` +
        `${numbers.join(', ')}: ${errors.map((e) => e?.message ?? JSON.stringify(e)).join('; ')}`,
    );
  }
  if (r.status !== 0) {
    fail(
      'GH_ERROR',
      `\`gh api graphql\` exited ${r.status} reading referenced issue(s) ${numbers.join(', ')}: ` +
        `${(r.stderr || '').trim() || '(no stderr)'}.`,
    );
  }
  if (parsed === null) {
    fail(
      'GH_BAD_JSON',
      `\`gh api graphql\` returned unparseable output reading referenced issue(s) ${numbers.join(', ')}.`,
    );
  }
  return mapRefsPayload(parsed, numbers);
}

/**
 * Referenced-but-not-closing issues, normalised into the exact shape
 * `pr.issues` already uses, so `partialWorkVerdict` and `adjudicateLabel` need
 * no second code path. `labelSet`/`timelineOf` are the gate's own fail-closed
 * connection readers, passed in rather than imported so this module never
 * imports the file that imports it.
 *
 * Excludes any number already in `closingIssuesReferences` (closing AND
 * writing "Refs" for the same issue is one link, not two) and silently drops
 * a number `refIssuesRaw` never resolved -- not fetched, or GitHub said no
 * such issue -- which is advisory input, not a refusal.
 *
 * @param {unknown} body
 * @param {Array<{number: unknown}>} closingIssueNodes
 * @param {unknown} refIssuesRaw
 * @param {(conn: unknown, what: string) => string[]} labelSet
 * @param {(conn: unknown, what: string) => unknown} timelineOf
 */
export function buildRefIssues(body, closingIssueNodes, refIssuesRaw, labelSet, timelineOf) {
  const closing = new Set(closingIssueNodes.map((i) => i?.number));
  const raw = refIssuesRaw && typeof refIssuesRaw === 'object' ? refIssuesRaw : {};
  const out = [];
  for (const n of extractRefIssueNumbers(body)) {
    if (closing.has(n)) continue;
    const node = raw[String(n)];
    if (node === undefined || node === null) continue;
    out.push({
      number: node.number,
      title: typeof node.title === 'string' ? node.title : '',
      state: typeof node.state === 'string' ? node.state : '(unknown)',
      labels: labelSet(node.labels, `Referenced issue #${node.number ?? n}`),
      labelHistory: timelineOf(node.timelineItems, `Referenced issue #${node.number ?? n}`),
    });
  }
  return out;
}

/**
 * The live-mode half of #4147: a second `gh` round trip, taken only when the
 * first payload's `closingIssuesReferences` closed nothing and the body names
 * at least one candidate. An ordinary PR that closes its issue never pays
 * this cost and cannot be failed by it -- `fetchRefsPayload` is simply never
 * called.
 *
 * @param {{ payload: unknown, repo: string, spawn: typeof import('node:child_process').spawnSync, fail: (reason: string, message: string) => never }} opts
 */
export function fetchRefIssuesIfNeeded({ payload, repo, spawn, fail }) {
  const rawPr = payload?.data?.repository?.pullRequest;
  const closingNodes = rawPr?.closingIssuesReferences?.nodes;
  if (!rawPr || !Array.isArray(closingNodes) || closingNodes.length > 0) return {};
  const numbers = extractRefIssueNumbers(rawPr.body);
  return fetchRefsPayload({ repo, numbers, spawn, fail });
}

/**
 * The complete PARTIAL_WORK verdict, or `null` when it does not apply -- no
 * referenced issue is both OPEN and carries `readyLabel` from an authorised
 * applier -- so the caller falls through to its existing NO_LINKED_ISSUE
 * failure unchanged. CLOSED is excluded deliberately (mitigation named in
 * #4147: "a closed issue is not a queue entry"). `adjudicateLabel` is passed
 * in rather than imported, so this module never imports the gate that
 * imports it. `escapeProblem`/`escapeReason` are threaded through exactly as
 * `evaluate`'s READY_ISSUE branch already does, so a bad escape label is
 * still reported as a note rather than silently dropped on this path.
 *
 * @param {{ refIssues: Array<{number:number, title:string, state:string, labels:string[], labelHistory:unknown}>, readyLabel: string, adjudicateLabel: (holder: unknown, label: string) => { ok: boolean, applier: string|null, at: string|null }, escapeProblem: string[] | null, escapeReason: string | null }} args
 */
export function partialWorkVerdict({ refIssues, readyLabel, adjudicateLabel, escapeProblem, escapeReason }) {
  const verdicts = refIssues.map((issue) => ({ issue, ...adjudicateLabel(issue, readyLabel) }));
  const passing = verdicts.filter((v) => v.ok && v.issue.state === 'OPEN');
  if (passing.length === 0) return null;
  const lines = [];
  for (const v of passing) {
    lines.push(
      `✅ PARTIAL_WORK: references #${v.issue.number} (${v.issue.state}) without closing it; it ` +
        `carries \`${readyLabel}\`` +
        (v.applier ? `, applied by \`${v.applier}\`` : '') +
        (v.at ? ` at ${v.at}` : '') +
        '.',
    );
    lines.push(`      ${v.issue.title}`);
  }
  lines.push(
    '   Honest partial work: this PR names a queued issue with a non-closing keyword (`Refs`/' +
      '`References`/`Part of`/`Towards`) instead of falsely claiming `Closes` on a slice.',
    '   `closingIssuesReferences` stays the primary, preferred signal -- a PR that closes its ' +
      'issue never reaches this path -- and the referenced issue must be OPEN and carry ' +
      `\`${readyLabel}\` from an authorised applier, exactly like a closing link would.`,
  );
  if (escapeProblem) lines.push('', ...escapeProblem, '   This PR passes on its referenced `ready` issue regardless.');
  return { ok: true, verdict: 'PARTIAL_WORK', escapeProblem: escapeProblem ? escapeReason : null, lines };
}

/**
 * A one-line diagnostic for the NO_LINKED_ISSUE failure message: referenced
 * issues existed but none was both OPEN and `readyLabel`. Empty array when
 * there is nothing to add, so the caller can always spread the result in.
 *
 * @param {Array<unknown>} refIssues
 * @param {string} readyLabel
 */
export function unqueuedRefsNote(refIssues, readyLabel) {
  if (refIssues.length === 0) return [];
  return [
    `   ${refIssues.length} issue(s) referenced in the body with a non-closing keyword exist, but ` +
      `none is both OPEN and \`${readyLabel}\` from an authorised applier, so the honest-partial-` +
      'work shape does not apply either.',
  ];
}
