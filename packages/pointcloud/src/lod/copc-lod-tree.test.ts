/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BlobByteSource } from '../streaming/blob-source.js';
import { CopcReader } from '../copc/copc-reader.js';
import { CopcHierarchy } from '../copc/copc-hierarchy.js';
import { createCopcLodTree } from './copc-lod-tree.js';
import { selectLod, type LodCamera } from './select.js';

const bytes = new Uint8Array(readFileSync(fileURLToPath(new URL('../../test-fixtures/tiny.copc.laz', import.meta.url))));

/** Orthographic camera looking down -Z at `center`, `height` world units tall, z in [0, 1]. */
function topDown(center: readonly number[], height: number): LodCamera {
  const [n, f] = [0.1, 1_000];
  const s = 2 / height;
  const [cx, cy, cz] = center;
  const ez = cz + 500;
  // Rows: x' = s(x - cx), y' = s(y - cy), z' = (ez - z - n) / (f - n), w = 1.
  const viewProj = [s, 0, 0, 0, 0, s, 0, 0, 0, 0, -1 / (f - n), 0, -s * cx, -s * cy, (ez - n) / (f - n), 1];
  return { viewProj, position: [cx, cy, ez], viewportHeight: 1_000, projScaleY: s, orthographic: true };
}

async function fixtureTree() {
  const reader = await CopcReader.open(new BlobByteSource(new Blob([bytes])));
  const hierarchy = new CopcHierarchy();
  hierarchy.addPage(reader.rootPageRef, await reader.readPage(reader.rootPageRef));
  return { reader, hierarchy, tree: createCopcLodTree(hierarchy, reader.file.info) };
}

describe('createCopcLodTree (#6869)', () => {
  it('puts node bounds in the decoded frame (native minus origin offset)', async () => {
    const reader = await CopcReader.open(new BlobByteSource(new Blob([bytes])));
    const hierarchy = new CopcHierarchy();
    hierarchy.addPage(reader.rootPageRef, await reader.readPage(reader.rootPageRef));
    const { center, halfsize } = reader.file.info;
    const root = createCopcLodTree(hierarchy, reader.file.info, center).root;
    expect(root?.bounds).toEqual({ min: [-halfsize, -halfsize, -halfsize], max: [halfsize, halfsize, halfsize] });
  });

  it('reports unknown children while the child pages are pending, then the real children', async () => {
    const { reader, hierarchy, tree } = await fixtureTree();
    const root = tree.root;
    if (!root) throw new Error('no root');
    expect(root.children).toBeNull();
    const pending = tree.pendingPagesUnder(root);
    expect(pending.length).toBe(hierarchy.pendingPages.size);
    for (const ref of pending) hierarchy.addPage(ref, await reader.readPage(ref));
    const kids = root.children ?? [];
    expect(kids.reduce((a, k) => a + k.pointCount, 0)).toBeGreaterThan(0);
    expect(kids.length).toBe(pending.length);
    for (const kid of kids) {
      expect(kid.id.startsWith('1-')).toBe(true);
      for (let a = 0; a < 3; a++) {
        expect(kid.bounds.min[a]).toBeGreaterThanOrEqual(root.bounds.min[a]);
        expect(kid.bounds.max[a]).toBeLessThanOrEqual(root.bounds.max[a]);
      }
    }
  });

  it('drives selectLod: needsChildren names the root until its pages load', async () => {
    const { reader, hierarchy, tree } = await fixtureTree();
    const root = tree.root;
    if (!root) throw new Error('no root');
    const cam = topDown(reader.file.info.center, 8); // zoomed in: the root spans far more than 96 px
    const first = selectLod(root, cam, { pointBudget: 100_000 });
    expect(first.nodes.map((s) => s.node.id)).toEqual(['0-0-0-0']);
    expect(first.needsChildren.map((n) => n.id)).toEqual(['0-0-0-0']);
    for (const ref of tree.pendingPagesUnder(root)) hierarchy.addPage(ref, await reader.readPage(ref));
    const second = selectLod(root, cam, { pointBudget: 100_000 });
    expect(second.nodes.length).toBeGreaterThan(1);
    expect(second.needsChildren).toEqual([]);
  });
});
