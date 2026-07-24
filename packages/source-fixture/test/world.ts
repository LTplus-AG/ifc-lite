/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { FixtureWorldSpec } from '../src/index.js';

/**
 * A small but structurally rich world, shared by both the conformance runs
 * and the fixture-specific behavior tests:
 *
 *   proj-1
 *     root1 "Design"                (top-level, has children)
 *       sub1 "Design/Structural"    (child of root1, has files directly)
 *         subsub1 "…/IFC"           (grandchild of root1 — must never leak
 *                                    into a direct-children query of root1)
 *           deep-file.ifc           (only visible when listFilesIsRecursive)
 *         structural-model.ifc      (2 revisions, distinct deterministic bytes)
 *         structural-notes.txt      (1 revision)
 *     root2 "Archive"               (top-level, no children, no files)
 */
export function buildTestWorldSpec(): FixtureWorldSpec {
  return {
    projects: [
      {
        id: 'proj-1',
        name: 'Alpha Tower',
        description: 'A fixture project with nested containers and multi-revision files.',
        containers: [
          { id: 'root1', name: 'Design' },
          { id: 'root2', name: 'Archive' },
          { id: 'sub1', name: 'Structural', parentId: 'root1' },
          { id: 'subsub1', name: 'IFC', parentId: 'sub1' },
        ],
        files: [
          {
            id: 'structural-model',
            name: 'structural-model.ifc',
            containerId: 'sub1',
            mimeType: 'application/octet-stream',
            revisions: [
              { id: 'rev2', label: 'Revision 2', content: 'REVISION-2::deterministic-content-longer-body' },
              { id: 'rev1', label: 'Revision 1', content: 'REVISION-1::short' },
            ],
          },
          {
            id: 'structural-notes',
            name: 'structural-notes.txt',
            containerId: 'sub1',
            mimeType: 'text/plain',
            revisions: [{ id: 'rev1', label: 'Revision 1', content: 'Notes on the structural model.' }],
          },
          {
            id: 'deep-file',
            name: 'deep-file.ifc',
            containerId: 'subsub1',
            mimeType: 'application/octet-stream',
            revisions: [{ id: 'rev1', label: 'Revision 1', content: 'DEEP-FILE::content' }],
          },
        ],
      },
    ],
  };
}
