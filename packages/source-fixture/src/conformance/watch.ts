/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import type { FileSourceProvider, PluginContext, SourceFileRef } from '@ifc-lite/plugin-api';

import type { ConformanceFixtures } from './types.js';

/** Same runaway-cursor cap `collectAllPages` uses; a hang is not a test result. */
const MAX_PAGES = 10_000;

/**
 * `watchRevisions` shape checks.
 *
 * Deliberately *not* asserted here: that a cursor comes back. It used to be,
 * unconditionally whenever `capabilities.changeDetection` was true — but
 * `RevisionWatchResult.cursor` is optional in the contract, documented as
 * what "providers with a delta endpoint" return to turn polling into one
 * cheap request. A provider with no delta endpoint (Dalux: every call
 * re-sweeps the given refs) has nothing to resume from, so returning none is
 * conformant and that check failed it for behaving correctly. Callers whose
 * provider *is* delta-backed opt the requirement back in with
 * `watchRevisionsHasDeltaFeed: true`.
 *
 * The same flag scopes the empty-ref check the other way: it binds polling
 * providers only, because the contract tells a delta-backed one to ignore
 * `refs` entirely. See the comment on that check.
 */
export function describeWatchRevisionsConformance(
  provider: FileSourceProvider,
  createContext: () => PluginContext,
  fixtures: ConformanceFixtures,
  hasDeltaFeed: boolean,
): void {
  describe.runIf(provider.manifest.capabilities.changeDetection)('watchRevisions', () => {
    /**
     * One ref for a file that genuinely exists in `containerWithFilesId`.
     *
     * Follows the cursor rather than reading only the first page. An empty
     * page that still carries a cursor is a conformant thing for a provider to
     * return — a backend-paged provider decides its own page size, and nothing
     * in the contract says the first page must be non-empty — and reading only
     * the first page turned that into an empty ref list. Every check below
     * would then have run against `[]`: "returns a well-formed result" would
     * pass on an empty events array and the delta-feed cursor check would pass
     * on a call that tracked nothing. Tests that cannot fail, and green.
     *
     * Empty after exhausting the pages is a *fixture* error, not a provider
     * verdict, so it throws with the fixture name rather than returning `[]`.
     */
    async function trackedRefs(ctx: PluginContext): Promise<SourceFileRef[]> {
      let cursor: string | undefined;
      for (let page = 0; page <= MAX_PAGES; page++) {
        const result = await provider.listFiles(
          ctx,
          fixtures.projectId,
          fixtures.containerWithFilesId,
          undefined,
          { cursor, limit: 1 },
        );
        const file = result.items[0] as (typeof result.items)[number] | undefined;
        if (file) {
          return [
            {
              projectId: fixtures.projectId,
              containerId: file.containerId,
              fileId: file.id,
              revisionId: file.currentRevisionId,
            },
          ];
        }
        if (result.cursor === undefined) break;
        cursor = result.cursor;
      }
      throw new Error(
        `conformance fixture containerWithFilesId (${fixtures.containerWithFilesId}) returned no files, ` +
          'so the watchRevisions checks would have run against an empty ref list and passed vacuously',
      );
    }

    it('returns a well-formed result', async () => {
      const ctx = createContext();
      const result = await provider.watchRevisions!(ctx, await trackedRefs(ctx), undefined, undefined);

      expect(Array.isArray(result.events), 'watchRevisions must return an events array').toBe(true);
      for (const event of result.events) {
        expect(typeof event.fileId, `event ${JSON.stringify(event)} has no string fileId`).toBe('string');
        expect(
          typeof event.latestRevisionId,
          `event for ${event.fileId} has no string latestRevisionId`,
        ).toBe('string');
      }
      // Optional, but when present it must be a usable token — an empty
      // string would fail every `if (cursor)` a host writes around it.
      if (result.cursor !== undefined) {
        expect(typeof result.cursor).toBe('string');
        expect(result.cursor.length, 'watchRevisions returned an empty-string cursor').toBeGreaterThan(0);
      }
    });

    // Watching nothing must report nothing. The failure this rules out is a
    // POLLING provider that answers an empty ref list by sweeping the whole
    // account and reporting every file it finds as an event — which reads to
    // the host as "everything just changed".
    //
    // POLLING ONLY, deliberately. The contract tells a delta/change-feed
    // provider to "use `cursor` and ignore `refs`"
    // (`packages/plugin-api/src/types.ts`, `watchRevisions`), so an initial
    // call — no cursor yet, and `refs: []` because the host has nothing to
    // poll — legitimately returns whatever the feed has. Those events are not
    // invented from a ref sweep, they are the feed doing its job, and there is
    // no ref list to have swept in the first place. Asserting zero here
    // unconditionally therefore fails a correct delta-backed provider for
    // obeying the very sentence that tells it to ignore `refs`.
    it.runIf(!hasDeltaFeed)('reports no events for an empty ref list', async () => {
      const ctx = createContext();
      const result = await provider.watchRevisions!(ctx, [], undefined, undefined);
      expect(result.events.length, 'watchRevisions invented events for an empty ref list').toBe(0);
    });

    it.runIf(hasDeltaFeed)('returns a cursor, and accepts it back', async () => {
      const ctx = createContext();
      const refs = await trackedRefs(ctx);
      const first = await provider.watchRevisions!(ctx, refs, undefined, undefined);
      expect(
        first.cursor,
        'watchRevisionsHasDeltaFeed was declared, so watchRevisions must return a resumable cursor',
      ).toBeDefined();

      // A cursor the provider will not take back is not a resumable token.
      const resumed = await provider.watchRevisions!(ctx, refs, first.cursor, undefined);
      expect(Array.isArray(resumed.events)).toBe(true);
    });
  });
}
