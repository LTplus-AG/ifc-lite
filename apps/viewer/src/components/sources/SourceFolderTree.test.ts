/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { SourceContainer } from '@ifc-lite/plugin-api';

import {
  buildContainerParentIndex,
  buildContainerTree,
  collectAncestorIds,
} from './SourceFolderTree';

describe('SourceFolderTree helpers', () => {
  const containers: SourceContainer[] = [
    { id: 'fa1', name: 'Area' },
    { id: 'folder-a', name: 'Folder A', parentId: 'fa1' },
    { id: 'folder-b', name: 'Folder B', parentId: 'folder-a' },
    { id: 'folder-c', name: 'Folder C', parentId: 'folder-b' },
    { id: 'other-root', name: 'Other Root', parentId: 'fa2' },
  ];

  it('builds only the subtree below the selected file area', () => {
    const tree = buildContainerTree(containers, 'fa1');

    assert.deepEqual(tree.map((node) => node.id), ['folder-a']);
    assert.deepEqual(tree[0].children.map((node) => node.id), ['folder-b']);
    assert.deepEqual(tree[0].children[0].children.map((node) => node.id), ['folder-c']);
  });

  it('collects ancestor ids from the selected node back to the file area root', () => {
    const parentById = buildContainerParentIndex(containers, 'fa1');

    assert.deepEqual(
      collectAncestorIds(parentById, 'folder-c', 'fa1'),
      ['folder-b', 'folder-a'],
    );
    assert.deepEqual(collectAncestorIds(parentById, 'folder-a', 'fa1'), []);
    assert.deepEqual(collectAncestorIds(parentById, 'fa1', 'fa1'), []);
  });
});
