/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import type { FileSourceProvider, PluginContext } from '@ifc-lite/plugin-api';

import { collectAllPages } from './collect.js';
import type { ConformanceFixtures } from './types.js';

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export function describeDownloadConformance(
  provider: FileSourceProvider,
  createContext: () => PluginContext,
  fixtures: ConformanceFixtures,
): void {
  describe('download', () => {
    // Gated on `downloadHistoricalRevisions`, not `revisionHistory`: listing
    // history and fetching it are separate capabilities, and a browser-only
    // provider can legitimately offer the first without the second.
    it.runIf(
      fixtures.fileWithRevisions !== undefined &&
        provider.manifest.capabilities.revisionHistory &&
        provider.manifest.capabilities.downloadHistoricalRevisions,
    )(
      'honors revisionId — different revisions yield different bytes',
      async () => {
        const ctx = createContext();
        const ref = { projectId: fixtures.projectId, ...fixtures.fileWithRevisions! };
        const revisions = await collectAllPages((request) => provider.listRevisions!(ctx, ref, request), 100);
        expect(revisions.length, 'fixture must supply a fileWithRevisions with 2+ revisions').toBeGreaterThanOrEqual(2);

        const [bufferA, bufferB] = await Promise.all(
          revisions.slice(0, 2).map((revision) => provider.download(ctx, { ...ref, revisionId: revision.id })),
        );
        expect(
          bytesEqual(new Uint8Array(bufferA), new Uint8Array(bufferB)),
          'download() returned identical bytes for two distinct revisionIds',
        ).toBe(false);
      },
    );

    it('rejects promptly on an already-aborted signal', async () => {
      const ctx = createContext();
      const page = await provider.listFiles(ctx, fixtures.projectId, fixtures.containerWithFilesId, undefined, {
        limit: 1,
      });
      expect(page.items.length, 'fixture must supply a containerWithFilesId that actually has files').toBeGreaterThan(0);
      const file = page.items[0];

      const controller = new AbortController();
      controller.abort();
      await expect(
        provider.download(
          ctx,
          { projectId: fixtures.projectId, containerId: file.containerId, fileId: file.id },
          { signal: controller.signal },
        ),
      ).rejects.toBeTruthy();
    });
  });
}
