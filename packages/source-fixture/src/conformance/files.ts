/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import type { FileSourceProvider, PluginContext } from '@ifc-lite/plugin-api';

import { collectAllPages, collectContainerIds } from './collect.js';
import type { ConformanceFixtures } from './types.js';

export function describeFileConformance(
  provider: FileSourceProvider,
  createContext: () => PluginContext,
  fixtures: ConformanceFixtures,
): void {
  describe('listFiles', () => {
    it('recursion matches capabilities.listFilesIsRecursive', async () => {
      const ctx = createContext();
      const files = await collectAllPages(
        (request) => provider.listFiles(ctx, fixtures.projectId, fixtures.containerWithFilesId, undefined, request),
        100,
      );
      expect(files.length, 'fixture must supply a containerWithFilesId that actually has files').toBeGreaterThan(0);

      if (provider.manifest.capabilities.listFilesIsRecursive) {
        const descendantIds = await collectContainerIds(provider, ctx, fixtures.projectId, fixtures.containerWithFilesId);
        for (const file of files) {
          const inScope = file.containerId === fixtures.containerWithFilesId || descendantIds.has(file.containerId);
          expect(
            inScope,
            `recursive listFiles returned ${file.id} from container ${file.containerId}, which is neither the queried container nor a descendant of it`,
          ).toBe(true);
        }
      } else {
        for (const file of files) {
          expect(
            file.containerId,
            `non-recursive listFiles returned ${file.id} from container ${file.containerId} instead of the queried ${fixtures.containerWithFilesId}`,
          ).toBe(fixtures.containerWithFilesId);
        }
      }
    });

    it('every returned containerId refers to a container listContainers also returns', async () => {
      const ctx = createContext();
      const files = await collectAllPages(
        (request) => provider.listFiles(ctx, fixtures.projectId, fixtures.containerWithFilesId, undefined, request),
        100,
      );
      const knownContainerIds = await collectContainerIds(provider, ctx, fixtures.projectId, undefined);
      // The queried container itself is a valid parentId root and may not
      // appear in its own descendant set, so it's allowed too.
      knownContainerIds.add(fixtures.containerWithFilesId);
      for (const file of files) {
        expect(
          knownContainerIds.has(file.containerId),
          `file ${file.id} declares containerId ${file.containerId}, which listContainers never returned for this project`,
        ).toBe(true);
      }
    });
  });
}
