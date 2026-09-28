/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { FixtureModelSpec, FixtureWorldSpec } from '../src/index.js';

import { buildTestWorldSpec } from './world.js';

/**
 * A commit chain with every case the History UI has to render, so the
 * conformance run and the derivation tests share one world:
 *
 *   c1  "Initial delivery"      wall-a, wall-b, slab-a            (added ×3)
 *   c2  "Coordination round 14" wall-a re-GUIDed to wall-a2,      (renamed)
 *                               slab-a geometry moved,            (modified)
 *                               wall-b unchanged
 *   c3  "Update slab openings"  slab-a data edited,               (modified)
 *                               wall-b deleted,                   (deleted)
 *                               door-a introduced                 (added)
 *   c4  "Pending upload"        status: pending — visible, and never the head
 *
 * `wall-a` → `wall-a2` is the load-bearing shape: its element history has to
 * survive a re-GUID, and a diff of c1 against c3 must pair it rather than
 * reporting one deletion and one addition.
 */

function fingerprint(key: string, ifcType: string, data: string, geometry?: string, pset?: string) {
  return {
    key,
    ifcType,
    dataHash: data,
    ...(geometry !== undefined ? { geometryHash: geometry } : {}),
    components: { 'attr:core': data, ...(pset !== undefined ? { 'pset:Pset_WallCommon': pset } : {}) },
    container: 'storey-1',
  };
}

const COMMIT_MODEL: FixtureModelSpec = {
  id: 'model-structural',
  name: 'Structural model',
  containerId: 'sub1',
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
        fingerprint('wall-a', 'IfcWall', 'd-wall-a-1', 'g-wall-a-1', 'p-wall-a-1'),
        fingerprint('wall-b', 'IfcWall', 'd-wall-b-1', 'g-wall-b-1', 'p-wall-b-1'),
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
      content: 'COMMIT-2::coordination-round-14',
      identity: [{ base: 'wall-a', here: 'wall-a2', reason: 'content-match:renamed' }],
      fingerprints: [
        fingerprint('wall-a2', 'IfcWall', 'd-wall-a-1', 'g-wall-a-1', 'p-wall-a-1'),
        fingerprint('wall-b', 'IfcWall', 'd-wall-b-1', 'g-wall-b-1', 'p-wall-b-1'),
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
      content: 'COMMIT-3::update-slab-openings',
      fingerprints: [
        fingerprint('wall-a2', 'IfcWall', 'd-wall-a-1', 'g-wall-a-1', 'p-wall-a-1'),
        fingerprint('slab-a', 'IfcSlab', 'd-slab-a-2', 'g-slab-a-2'),
        fingerprint('door-a', 'IfcDoor', 'd-door-a-1', 'g-door-a-1'),
      ],
    },
    {
      id: 'c4',
      parents: ['c3'],
      createdAt: '2026-09-26T07:00:00.000Z',
      author: 'J. Hansen',
      message: 'Awaiting review',
      status: 'pending',
      fileName: 'structural-c4.ifc',
      content: 'COMMIT-4::pending',
      fingerprints: [fingerprint('wall-a2', 'IfcWall', 'd-wall-a-2', 'g-wall-a-1', 'p-wall-a-1')],
    },
  ],
};

/** An empty model the write checks may append to without disturbing the chain above. */
const WRITABLE_MODEL: FixtureModelSpec = {
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
};

/** The 2.0.0 world, plus the two models above in `proj-1`. */
export function buildCommitWorldSpec(): FixtureWorldSpec {
  const base = buildTestWorldSpec();
  return {
    projects: base.projects.map((project) =>
      project.id === 'proj-1' ? { ...project, models: [COMMIT_MODEL, WRITABLE_MODEL] } : project,
    ),
  };
}
