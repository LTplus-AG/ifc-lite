/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Pins that the `watchRevisions` checks actually track a real file (#2493).
//
// `trackedRefs` used to read only the FIRST page of `listFiles`. An empty page
// that still carries a cursor is a conformant thing for a provider to return —
// under `pageBoundary: 'backend'` the page size is the backend's to choose, and
// nothing in the contract says the first page must be non-empty — and the
// helper turned that into an empty ref list. Every check in the file then ran
// against `[]`: "returns a well-formed result" passes on an empty events array,
// and the delta-feed cursor check passes on a call that tracked nothing. Green,
// and proving nothing.
//
// The assertion here is on the ref list `watchRevisions` was actually handed,
// which is the only thing that distinguishes a real run from a vacuous one.

import { describe, expect, it } from 'vitest';
import type {
  FileFilter,
  FileSourceProvider,
  ListOptions,
  Page,
  PluginContext,
  RevisionWatchResult,
  SourceFile,
  SourceFileRef,
} from '@ifc-lite/plugin-api';

import { createFixtureContext, createFixtureSourceProvider } from '../src/index.js';
import type { ConformanceFixtures } from '../src/conformance/index.js';
import { describeWatchRevisionsConformance } from '../src/conformance/watch.js';
import { buildTestWorldSpec } from './world.js';

const fixtures: ConformanceFixtures = {
  projectId: 'proj-1',
  containerWithFilesId: 'sub1',
  fileWithRevisions: { containerId: 'sub1', fileId: 'structural-model' },
  searchQuery: 'structural',
  secondProjectId: 'proj-2',
};

/**
 * A provider whose FIRST `listFiles` page is empty but cursored, and whose
 * files only appear from the second page on. Legal, and exactly the shape that
 * made the old first-page-only helper give up.
 *
 * `watchRevisions` records the refs it is given so the run can be checked for
 * vacuity afterwards.
 */
function lateFilesProvider(seenRefs: SourceFileRef[][]): FileSourceProvider {
  const base = createFixtureSourceProvider({ world: buildTestWorldSpec(), pageSize: 1 });
  const EMPTY_FIRST_PAGE_CURSOR = 'conformance-test-empty-first-page';

  return {
    ...base,
    listFiles: async (
      ctx: PluginContext,
      projectId: string,
      containerId: string,
      filter?: FileFilter,
      options?: ListOptions,
    ): Promise<Page<SourceFile>> => {
      if (options?.cursor === undefined) {
        // The empty-but-cursored first page. The cursor is our own sentinel;
        // handing the real provider a cursor it never minted would be a
        // different bug, so it is swapped back out below.
        return { items: [], cursor: EMPTY_FIRST_PAGE_CURSOR };
      }
      const cursor = options.cursor === EMPTY_FIRST_PAGE_CURSOR ? undefined : options.cursor;
      return base.listFiles(ctx, projectId, containerId, filter, { ...options, cursor });
    },
    watchRevisions: (
      ctx: PluginContext,
      refs: readonly SourceFileRef[],
      cursor?: string,
      options?: ListOptions,
    ): Promise<RevisionWatchResult> => {
      seenRefs.push([...refs]);
      return base.watchRevisions!(ctx, refs, cursor, options);
    },
  } as FileSourceProvider;
}

describe('watchRevisions conformance tracks a real file', () => {
  const seenRefs: SourceFileRef[][] = [];
  describeWatchRevisionsConformance(lateFilesProvider(seenRefs), () => createFixtureContext(), fixtures, false);

  // Declared after the suite so it observes a completed run — same shape as
  // `conformance-page-boundary.test.ts`, and a plain `it` for the same reason:
  // a failing hook would not move the leaf test count.
  it('hands watchRevisions a non-empty ref list even when the first page is empty', () => {
    expect(
      seenRefs.length,
      'watchRevisions was never called — this run proves nothing',
    ).toBeGreaterThan(0);

    // The empty-ref check deliberately passes `[]`; every OTHER call must have
    // tracked a real file, or the suite is measuring nothing.
    const tracking = seenRefs.filter((refs) => refs.length > 0);
    expect(
      tracking.length,
      'every watchRevisions call got an empty ref list, so the checks passed vacuously',
    ).toBeGreaterThan(0);

    for (const refs of tracking) {
      for (const ref of refs) {
        expect(ref.projectId).toBe(fixtures.projectId);
        expect(typeof ref.fileId, `ref ${JSON.stringify(ref)} has no fileId`).toBe('string');
        expect(ref.fileId.length).toBeGreaterThan(0);
      }
    }
  });
});
