/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import type { FileSourceProvider, PluginContext, SourceContainer } from '@ifc-lite/plugin-api';

import { collectAllPages } from './collect.js';
import type { ConformanceFixtures } from './types.js';

/**
 * Verifies `listContainers` matches the shape `capabilities.containerListing`
 * promises, for both the top-level query (`parentId` omitted) and a scoped
 * query into a known container:
 *
 * - `direct-children`: the result is only immediate children — no
 *   grandchildren. Checked by independently querying each returned
 *   container's own children and confirming none of them already appeared
 *   one level up.
 * - `flat-subtree`: the result is every descendant flattened, and every
 *   non-root item's `parentId` chains back to the queried container within
 *   the returned set — one connected tree, not a disjoint pile that merely
 *   shares a project.
 */
export function describeContainerListingConformance(
  provider: FileSourceProvider,
  createContext: () => PluginContext,
  fixtures: ConformanceFixtures,
): void {
  const mode = provider.manifest.capabilities.containerListing;

  describe('listContainers / containerListing mode', () => {
    it('top-level query (no parentId) matches the declared mode', async () => {
      const ctx = createContext();
      const topLevel = await collectAllPages(
        (request) => provider.listContainers(ctx, fixtures.projectId, undefined, request),
        100,
      );

      if (mode === 'direct-children') {
        assertNoParentId(topLevel, 'top-level');
        await assertNoGrandchildren(provider, ctx, fixtures.projectId, topLevel);
      } else {
        assertConnectedSubtree(topLevel, undefined);
      }
    });

    it.runIf(fixtures.containerWithChildrenId !== undefined)(
      'scoped query (with parentId) matches the declared mode',
      async () => {
        const ctx = createContext();
        const parentId = fixtures.containerWithChildrenId!;
        const scoped = await collectAllPages(
          (request) => provider.listContainers(ctx, fixtures.projectId, parentId, request),
          100,
        );
        expect(scoped.length, 'fixture must supply a containerWithChildrenId that actually has children').toBeGreaterThan(0);
        expect(scoped.some((c) => c.id === parentId), 'result must not include the queried container itself').toBe(false);

        if (mode === 'direct-children') {
          await assertNoGrandchildren(provider, ctx, fixtures.projectId, scoped);
        } else {
          assertConnectedSubtree(scoped, parentId);
        }
      },
    );
  });
}

function assertNoParentId(containers: readonly SourceContainer[], label: string): void {
  for (const container of containers) {
    expect(container.parentId, `${label} result included ${container.id} with parentId set`).toBeUndefined();
  }
}

/** direct-children: querying each returned container's own children must never reproduce an id already seen at this level. */
async function assertNoGrandchildren(
  provider: FileSourceProvider,
  ctx: PluginContext,
  projectId: string,
  level: readonly SourceContainer[],
): Promise<void> {
  const levelIds = new Set(level.map((c) => c.id));
  for (const container of level) {
    const children = await collectAllPages(
      (request) => provider.listContainers(ctx, projectId, container.id, request),
      100,
    );
    for (const child of children) {
      expect(
        levelIds.has(child.id),
        `direct-children mode leaked ${child.id} (a child of ${container.id}) into the level above it`,
      ).toBe(false);
    }
  }
}

/**
 * flat-subtree: every returned item is either a genuine root (`parentId`
 * undefined, only valid when `queriedParentId` is itself undefined — i.e.
 * this *is* the top-level query) or its `parentId` resolves to
 * `queriedParentId` or another item in the same result — so the whole
 * result forms one connected tree with no orphaned branch.
 */
function assertConnectedSubtree(subtree: readonly SourceContainer[], queriedParentId: string | undefined): void {
  expect(subtree.some((c) => c.id === queriedParentId), 'result must not include the queried container itself').toBe(false);
  const idsInSubtree = new Set(subtree.map((c) => c.id));
  for (const container of subtree) {
    if (container.parentId === undefined) {
      expect(queriedParentId, `container ${container.id} has no parentId but this was a scoped (non-top-level) query`).toBeUndefined();
      continue;
    }
    const rootsBack = container.parentId === queriedParentId || idsInSubtree.has(container.parentId);
    expect(
      rootsBack,
      `container ${container.id} has parentId ${container.parentId}, which is neither the queried container nor another item in the returned subtree`,
    ).toBe(true);
  }
}
