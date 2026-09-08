/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The conformance kit must accept a DELTA-BACKED `watchRevisions`.
 *
 * `FileSourceProvider.watchRevisions` tells a provider with a delta or
 * change-feed endpoint to "use `cursor` and ignore `refs`"
 * (`packages/plugin-api/src/types.ts`). An initial call therefore arrives with
 * no cursor and — when the host is not polling anything — `refs: []`, and the
 * feed legitimately answers with whatever it holds. The suite's
 * "reports no events for an empty ref list" check asserted zero events
 * unconditionally, which failed that provider for obeying the contract, so it
 * is now scoped to polling providers.
 *
 * This file is the guard on that scoping. `fixture.test.ts` already covers the
 * polling side end to end (the fixture provider is polling), so what is missing
 * — and what the fix is about — is a provider on the OTHER side of the flag.
 *
 * Both suites below run the real `describeWatchRevisionsConformance`, so a
 * regression is reported as the kit failing a correct provider rather than as a
 * paraphrase of it.
 */

import { describe, expect, it } from 'vitest';
import type { FileSourceProvider, RevisionWatchResult, SourceFileRef } from '@ifc-lite/plugin-api';

import { createFixtureContext, createFixtureSourceProvider } from '../src/index.js';
import type { ConformanceFixtures } from '../src/conformance/index.js';
import { describeWatchRevisionsConformance } from '../src/conformance/watch.js';
import { buildTestWorldSpec } from './world.js';

const fixtures: ConformanceFixtures = {
  projectId: 'proj-1',
  containerWithChildrenId: 'root1',
  containerWithFilesId: 'sub1',
  fileWithRevisions: { containerId: 'sub1', fileId: 'structural-model' },
};

const base = createFixtureSourceProvider({ world: buildTestWorldSpec() });

/** Calls the delta provider's `watchRevisions` saw, for the reachability check below. */
const deltaCalls: Array<{ refs: readonly SourceFileRef[]; cursor: string | undefined }> = [];

/**
 * A correct delta-backed provider: it never reads `refs`, it resumes from
 * `cursor`, and it hands back a fresh cursor every call. The single event it
 * reports comes from the feed, not from sweeping an account — which is exactly
 * why the polling-only assertion was wrong to apply to it.
 */
const deltaProvider: FileSourceProvider = {
  ...base,
  watchRevisions: async (_ctx, refs, cursor): Promise<RevisionWatchResult> => {
    deltaCalls.push({ refs, cursor });
    return {
      events: [{ fileId: 'structural-model', latestRevisionId: 'rev-2' }],
      cursor: cursor === undefined ? 'feed@1' : `${cursor}+1`,
    };
  },
};

describe('conformance kit — delta-backed watchRevisions', () => {
  describeWatchRevisionsConformance(deltaProvider, () => createFixtureContext(), fixtures, true);

  // Reachability: the suite above is `describe.runIf(changeDetection)`, so a
  // provider whose manifest lost that capability would make every assertion in
  // it vanish silently and this file would go green while testing nothing.
  it('ran against a provider the suite actually exercises', () => {
    expect(deltaProvider.manifest.capabilities.changeDetection).toBe(true);
    expect(deltaCalls.length).toBeGreaterThan(0);
  });

  // And the passing suite above is not passing for a trivial reason. This
  // provider answers `refs: []` with a real feed event, which is precisely what
  // the unconditional "reports no events for an empty ref list" assertion
  // rejected. Without this, a stub that happened to return nothing would make
  // the suite green whether or not the check was scoped, and the guard would be
  // vacuous.
  it('answers an empty ref list from its feed — what the old check rejected', async () => {
    const result = await deltaProvider.watchRevisions!(createFixtureContext(), [], undefined, undefined);
    expect(result.events.length).toBeGreaterThan(0);
    expect(result.cursor).toBeDefined();
  });
});
