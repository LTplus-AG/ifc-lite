/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { createCollabDoc, entityToJSON, getEntity } from '@ifc-lite/collab';
import type { IfcxFile } from '@ifc-lite/ifcx';
import { seedDraftDoc } from './layer-store.js';

function layer(data: IfcxFile['data']): IfcxFile {
  return {
    header: {
      id: 'l',
      ifcxVersion: 'ifcx_alpha',
      dataVersion: '1.0.0',
      author: 'test',
      timestamp: '2026-01-01T00:00:00Z',
    },
    imports: [],
    schemas: {},
    data,
  };
}

describe('seedDraftDoc', () => {
  it('replays inherits deltas from later layers onto existing entities', () => {
    const doc = createCollabDoc({ gc: false });
    seedDraftDoc(doc, [
      layer([
        { path: 'wall-1', inherits: { Type: 'type-a' }, attributes: { Name: 'W1' } },
        { path: 'door-1', inherits: { Type: 'type-d' } },
      ]),
      // Later base layer retargets one inheritance and removes the other.
      layer([
        { path: 'wall-1', inherits: { Type: 'type-b' } },
        { path: 'door-1', inherits: { Type: null } },
      ]),
    ]);

    const wall = getEntity(doc, 'wall-1');
    const door = getEntity(doc, 'door-1');
    expect(wall && entityToJSON(wall).inherits).toEqual({ Type: 'type-b' });
    expect(door && entityToJSON(door).inherits).toEqual({});
  });
});
