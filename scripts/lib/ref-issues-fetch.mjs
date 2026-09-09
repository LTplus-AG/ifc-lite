/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/**
 * The GraphQL-fetching half of #4147's honest-partial-work path, split out of
 * `./issue-refs.mjs` (#4180 finding B's fix pushed that file over the 400-line
 * `check-module-size.mjs` limit with no allowlist row -- AGENTS.md's house
 * rule is to split, not to add a budget exemption).
 *
 * THE SPLIT LINE: `issue-refs.mjs` answers "what does this PR body SAY" (a
 * `Refs #12`, a near-miss, a stripped-prose scan) from the body text alone,
 * no network. This module answers "what IS #12" -- it takes the numbers
 * `extractRefIssueNumbers` (still in `issue-refs.mjs`) already found and
 * fetches their real state, labels and label history from GitHub, in the
 * exact shape `check-issue-queue.mjs` already trusts for a closing link. Every
 * function here either builds that GraphQL query, shapes its response, or
 * calls `gh` -- `extractRefIssueNumbers` is the one import back into
 * `issue-refs.mjs`, and nothing here is called unless `closingIssuesReferences`
 * already closed nothing and the body named a candidate, so an ordinary PR
 * that closes its issue never reaches this file.
 */

import { extractRefIssueNumbers } from './issue-refs.mjs';

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
