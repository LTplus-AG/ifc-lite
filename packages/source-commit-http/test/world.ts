/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { FixtureWorldSpec } from '@ifc-lite/source-fixture';

function fingerprint(key: string, ifcType: string, data: string, geometry?: string) {
  return {
    key,
    ifcType,
    dataHash: data,
    ...(geometry !== undefined ? { geometryHash: geometry } : {}),
    components: { 'attr:core': data },
    container: 'storey-1',
  };
}

/**
 * Three published commits with a re-GUID in the middle, plus an empty-ish
 * model for the write checks. Same shape as the fixture package's own commit
 * world — the HTTP layer has to preserve exactly these facts across JSON.
 */
export function buildWorld(): FixtureWorldSpec {
  return {
    projects: [
      {
        id: 'proj-1',
        name: 'Alpha Tower',
        containers: [],
        files: [],
        models: [
          {
            id: 'model-structural',
            name: 'Structural model',
            discipline: 'S',
            commits: [
              {
                id: 'c1',
                parents: [],
                createdAt: '2026-03-03T08:00:00.000Z',
                author: 'A. Holm',
                message: 'Initial delivery',
                fileName: 'structural-c1.ifc',
                content: 'COMMIT-1::initial-delivery',
                fingerprints: [
                  fingerprint('wall-a', 'IfcWall', 'd-wall-a-1', 'g-wall-a-1'),
                  fingerprint('slab-a', 'IfcSlab', 'd-slab-a-1', 'g-slab-a-1'),
                ],
              },
              {
                id: 'c2',
                parents: ['c1'],
                createdAt: '2026-09-12T11:30:00.000Z',
                author: 'M. Berg',
                message: 'Coordination round 14',
                fileName: 'structural-c2.ifc',
                content: 'COMMIT-2::coordination',
                identity: [{ base: 'wall-a', here: 'wall-a2', reason: 'content-match:renamed' }],
                fingerprints: [
                  fingerprint('wall-a2', 'IfcWall', 'd-wall-a-1', 'g-wall-a-1'),
                  fingerprint('slab-a', 'IfcSlab', 'd-slab-a-1', 'g-slab-a-2'),
                ],
              },
              {
                id: 'c3',
                parents: ['c2'],
                createdAt: '2026-09-25T09:15:00.000Z',
                author: 'J. Hansen',
                message: 'Update slab openings level 3',
                fileName: 'structural-c3.ifc',
                content: 'COMMIT-3::slab-openings',
                fingerprints: [
                  fingerprint('wall-a2', 'IfcWall', 'd-wall-a-1', 'g-wall-a-1'),
                  fingerprint('slab-a', 'IfcSlab', 'd-slab-a-2', 'g-slab-a-2'),
                  fingerprint('door-a', 'IfcDoor', 'd-door-a-1', 'g-door-a-1'),
                ],
              },
            ],
          },
          {
            id: 'model-uploads',
            name: 'Upload target',
            commits: [
              {
                id: 'u1',
                parents: [],
                createdAt: '2026-01-01T00:00:00.000Z',
                message: 'Seed',
                fileName: 'uploads-u1.ifc',
                content: 'UPLOAD-SEED',
                fingerprints: [fingerprint('seed-a', 'IfcWall', 'd-seed-a-1')],
              },
            ],
          },
        ],
      },
      { id: 'proj-2', name: 'Beta Campus', containers: [], files: [] },
    ],
  };
}
