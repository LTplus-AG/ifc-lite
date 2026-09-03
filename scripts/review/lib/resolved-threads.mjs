/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * WHICH INLINE COMMENTS SIT ON A REVIEW THREAD SOMEONE HAS RESOLVED (#3768).
 *
 * REST's `pulls/{n}/comments` exposes no resolution state at all, and its
 * `commit_id` is a pointer GitHub RELOCATES onto whatever the head currently is
 * (#3729). Put together, a PR that once received any finding could never again
 * carry a `verdict=clean` marker: every prior finding kept reporting the current
 * head, resolving its thread changed nothing a REST reader could see, and the
 * only way out was DELETING the comments -- which destroys the audit trail.
 * Resolution lives in GraphQL `reviewThreads.isResolved` and nowhere else, so
 * this module is the one GraphQL call in the lane.
 *
 * IT FAILS CLOSED, AND THE DIRECTION MATTERS. A thread this cannot account for
 * -- the page cap was hit, a shape changed, `gh` failed -- is simply ABSENT from
 * the returned set, so its comments count as UNRESOLVED and keep blocking a
 * clean verdict. There is no path where a failed read makes a PR look cleaner
 * than it is; a failed read makes it look exactly as blocked as before this
 * module existed. Every such shortfall is also reported in `warnings`, because
 * an unread page silently reading as "nothing there" is the defect one layer
 * below where this lane usually catches it.
 *
 * IT NEVER THROWS. The caller is deciding between `clean` and `findings` on a
 * run that already succeeded; a GraphQL hiccup must not turn that into a red
 * job, and it does not have to, because the fail-closed direction already gives
 * the safe answer.
 *
 * THE CLIENT IS INJECTABLE, unlike the rest of post-review.mjs, whose docblock
 * states outright that it has no test seam. That is not a reversal: the seam is
 * here, in a module that is a pure function of what GraphQL returns, and
 * post-review.mjs still calls it with the real `gh` and is still driven as a
 * process by a fake `gh` on PATH. The pagination and shape handling is what
 * wants unit tests; the ordering of network calls is what wants the process.
 */

import { gh } from '../../lib/gh.mjs';

/** Threads per page, and comments per thread per page. GitHub's max for both. */
const PAGE_SIZE = 100;

/** Pages of threads to walk before giving up. 20 * 100 = 2000 threads. */
export const MAX_THREAD_PAGES = 20;

export const RESOLVED_THREADS_QUERY = `
query($owner: String!, $name: String!, $pr: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $pr) {
      reviewThreads(first: ${PAGE_SIZE}, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          isResolved
          comments(first: ${PAGE_SIZE}) {
            pageInfo { hasNextPage }
            nodes { databaseId }
          }
        }
      }
    }
  }
}`;

/**
 * The comment ids of every RESOLVED review thread on a pull request.
 *
 * @param {string} repo  `owner/name`
 * @param {string|number} pr
 * @param {{ghClient?: Function, maxPages?: number}} [opts] `ghClient` takes the
 *   same `(args, what)` as lib/gh.mjs's `gh` and returns parsed JSON.
 * @returns {{ids: Set<number>, warnings: string[], complete: boolean}}
 */
export function resolvedCommentIds(repo, pr, { ghClient = gh, maxPages = MAX_THREAD_PAGES } = {}) {
  const ids = new Set();
  const warnings = [];
  const [owner, name] = String(repo).split('/');
  if (!owner || !name) {
    return { ids, warnings: [`\`${repo}\` is not \`owner/name\`, so no thread could be read.`], complete: false };
  }

  let cursor = null;
  let complete = false;
  for (let page = 0; page < maxPages; page += 1) {
    let body;
    try {
      body = ghClient(
        [
          'api',
          'graphql',
          '-f',
          `query=${RESOLVED_THREADS_QUERY}`,
          '-F',
          `owner=${owner}`,
          '-F',
          `name=${name}`,
          '-F',
          `pr=${Number(pr)}`,
          ...(cursor === null ? [] : ['-F', `cursor=${cursor}`]),
        ],
        `resolved review threads on #${pr}`,
      );
    } catch (err) {
      warnings.push(`Could not read review-thread resolution (${err?.reason ?? 'error'}): ${err?.message ?? err}`);
      break;
    }
    // A GraphQL 200 can carry `errors` alongside a partial `data`. Counting a
    // partial page as the whole answer is how a truncated read turns into a
    // false clean, so it is warned about and the walk stops.
    if (Array.isArray(body?.errors) && body.errors.length > 0) {
      warnings.push(`GraphQL returned ${body.errors.length} error(s): ${body.errors.map((e) => e?.message).join('; ')}`);
      break;
    }
    const threads = body?.data?.repository?.pullRequest?.reviewThreads;
    const nodes = threads?.nodes;
    if (!Array.isArray(nodes)) {
      warnings.push('GraphQL returned no `reviewThreads.nodes` array; treating every thread as unresolved.');
      break;
    }
    for (const t of nodes) {
      if (t?.isResolved !== true) continue;
      const cs = t?.comments;
      for (const c of Array.isArray(cs?.nodes) ? cs.nodes : []) {
        if (Number.isInteger(c?.databaseId)) ids.add(c.databaseId);
      }
      // A resolved thread longer than one page: the comments we did not see stay
      // out of the set, so they keep blocking. Said out loud rather than left as
      // a silent shortfall.
      if (cs?.pageInfo?.hasNextPage === true) {
        warnings.push(`A resolved thread has more than ${PAGE_SIZE} comments; the rest still count as unresolved.`);
      }
    }
    if (threads?.pageInfo?.hasNextPage !== true) {
      complete = true;
      break;
    }
    cursor = threads?.pageInfo?.endCursor;
    if (typeof cursor !== 'string' || cursor === '') {
      warnings.push('GraphQL says there is another page of threads but gave no cursor; stopping.');
      break;
    }
  }
  if (!complete && warnings.length === 0) {
    warnings.push(`Walked ${maxPages} page(s) of review threads and there were still more; the rest count as unresolved.`);
  }
  return { ids, warnings, complete };
}
