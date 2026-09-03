/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The direction is the whole test. Every shape this cannot read must leave the
 * comment OUT of the resolved set, because being out of the set is what keeps a
 * finding blocking a clean verdict (#3768). A test that only checked the happy
 * path could not tell fail-closed from fail-open, and fail-open here means a PR
 * certified clean over findings nobody withdrew.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvedCommentIds, RESOLVED_THREADS_QUERY } from './resolved-threads.mjs';

const thread = (isResolved, ids, hasNextPage = false) => ({
  isResolved,
  comments: { pageInfo: { hasNextPage }, nodes: ids.map((databaseId) => ({ databaseId })) },
});

const page = (nodes, hasNextPage = false, endCursor = null) => ({
  data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage, endCursor }, nodes } } } },
});

test('only RESOLVED threads contribute their comment ids', () => {
  const { ids, warnings, complete } = resolvedCommentIds('o/n', 7, {
    ghClient: () => page([thread(true, [1, 2]), thread(false, [3]), thread(null, [4])]),
  });
  assert.deepEqual([...ids].sort(), [1, 2]);
  assert.deepEqual(warnings, []);
  assert.equal(complete, true);
});

test('the query and variables are what gh is actually asked for', () => {
  let seen = null;
  resolvedCommentIds('acme/widgets', '42', { ghClient: (args) => { seen = args; return page([]); } });
  assert.deepEqual(seen.slice(0, 2), ['api', 'graphql']);
  assert.ok(seen.includes(`query=${RESOLVED_THREADS_QUERY}`));
  assert.ok(seen.includes('owner=acme'));
  assert.ok(seen.includes('name=widgets'));
  assert.ok(seen.includes('pr=42'));
  // No cursor on the first page: `after: null` is the first page, and sending
  // the string "null" would be a cursor GitHub rejects.
  assert.ok(!seen.some((a) => String(a).startsWith('cursor=')));
});

test('it pages, carrying the cursor forward', () => {
  const cursors = [];
  const pages = [page([thread(true, [1])], true, 'CUR1'), page([thread(true, [2])], false, null)];
  const { ids, complete } = resolvedCommentIds('o/n', 7, {
    ghClient: (args) => {
      cursors.push(args.find((a) => String(a).startsWith('cursor=')) ?? null);
      return pages.shift();
    },
  });
  assert.deepEqual([...ids].sort(), [1, 2]);
  assert.deepEqual(cursors, [null, 'cursor=CUR1']);
  assert.equal(complete, true);
});

test('a thrown gh call yields NO resolved ids, so every finding still blocks', () => {
  const { ids, warnings, complete } = resolvedCommentIds('o/n', 7, {
    ghClient: () => { const e = new Error('gh exited 1'); e.reason = 'GH_ERROR'; throw e; },
  });
  assert.equal(ids.size, 0);
  assert.equal(complete, false);
  assert.match(warnings[0], /Could not read review-thread resolution \(GH_ERROR\)/);
});

test('a 200 carrying GraphQL `errors` is not read as a complete answer', () => {
  const { ids, warnings, complete } = resolvedCommentIds('o/n', 7, {
    ghClient: () => ({ ...page([thread(true, [1])]), errors: [{ message: 'Something went wrong' }] }),
  });
  assert.equal(ids.size, 0, 'a partial page must not resolve anything');
  assert.equal(complete, false);
  assert.match(warnings[0], /GraphQL returned 1 error\(s\): Something went wrong/);
});

test('a response missing the nodes array is refused rather than read as empty', () => {
  const { ids, warnings, complete } = resolvedCommentIds('o/n', 7, { ghClient: () => ({ data: {} }) });
  assert.equal(ids.size, 0);
  assert.equal(complete, false);
  assert.match(warnings[0], /no `reviewThreads.nodes` array/);
});

test('the page cap stops the walk and says so, leaving the unseen threads blocking', () => {
  const { ids, warnings, complete } = resolvedCommentIds('o/n', 7, {
    maxPages: 2,
    ghClient: () => page([thread(true, [9])], true, 'MORE'),
  });
  assert.deepEqual([...ids], [9], 'what WAS read still counts');
  assert.equal(complete, false);
  assert.match(warnings[0], /Walked 2 page\(s\).*still more/);
});

test('a resolved thread longer than one page keeps its unread comments blocking', () => {
  const { ids, warnings } = resolvedCommentIds('o/n', 7, {
    ghClient: () => page([thread(true, [1], true)]),
  });
  assert.deepEqual([...ids], [1]);
  assert.match(warnings[0], /more than 100 comments/);
});

test('a repo that is not `owner/name` reads nothing and never calls gh', () => {
  let called = false;
  const { ids, warnings } = resolvedCommentIds('not-a-repo', 7, {
    ghClient: () => { called = true; return page([]); },
  });
  assert.equal(called, false);
  assert.equal(ids.size, 0);
  assert.match(warnings[0], /is not `owner\/name`/);
});

test('a non-integer databaseId is dropped rather than poisoning the set', () => {
  const { ids } = resolvedCommentIds('o/n', 7, {
    ghClient: () => page([thread(true, [1]), { isResolved: true, comments: { pageInfo: {}, nodes: [{ databaseId: 'x' }, {}] } }]),
  });
  assert.deepEqual([...ids], [1]);
});

test('a cursor-less next page stops the walk instead of refetching page 1 forever', () => {
  let calls = 0;
  const { warnings, complete } = resolvedCommentIds('o/n', 7, {
    ghClient: () => { calls += 1; return page([], true, null); },
  });
  assert.equal(calls, 1);
  assert.equal(complete, false);
  assert.match(warnings[0], /gave no cursor/);
});
