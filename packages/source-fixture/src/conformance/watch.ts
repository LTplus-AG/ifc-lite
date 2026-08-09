/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import type { FileSourceProvider, PluginContext } from '@ifc-lite/plugin-api';

import type { ConformanceFixtures } from './types.js';

export function describeWatchRevisionsConformance(
  provider: FileSourceProvider,
  createContext: () => PluginContext,
  fixtures: ConformanceFixtures,
): void {
  describe.runIf(provider.manifest.capabilities.changeDetection)('watchRevisions', () => {
    it('returns a cursor', async () => {
      const ctx = createContext();
      const page = await provider.listFiles(ctx, fixtures.projectId, fixtures.containerWithFilesId, undefined, {
        limit: 1,
      });
      const file = page.items[0] as (typeof page.items)[number] | undefined;
      const refs = file
        ? [
            {
              projectId: fixtures.projectId,
              containerId: file.containerId,
              fileId: file.id,
              revisionId: file.currentRevisionId,
            },
          ]
        : [];

      const result = await provider.watchRevisions!(ctx, refs, undefined, undefined);
      expect(result.cursor, 'watchRevisions must return a cursor when capabilities.changeDetection is true').toBeDefined();
    });
  });
}
