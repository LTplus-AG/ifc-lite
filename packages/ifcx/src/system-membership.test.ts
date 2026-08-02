/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IFC5 system membership -> AssignsToGroup edges (#1622 IFCX follow-up).
 *
 * IFCX carries group/system membership as a `bsi::ifc::system::partofsystem`
 * attribute on the MEMBER node (an array of `{ ref }` objects pointing at the
 * IfcSystem-family node) — see the buildingSMART Domestic_Hot_Water sample.
 * parseIfcx must surface those as RelationshipType.AssignsToGroup edges in
 * STEP direction (group -> member) so the shared readers
 * (extractGroupMembersOnDemand, the viewer's Groups tab) work unchanged.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { RelationshipType } from '@ifc-lite/data';
import { parseIfcx } from './index.js';
import { ATTR } from './types.js';

function toBuffer(doc: unknown): ArrayBuffer {
  const bytes = new TextEncoder().encode(JSON.stringify(doc));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function ifcClass(code: string) {
  return {
    code,
    uri: `https://identifier.buildingsmart.org/uri/buildingsmart/ifc/5/class/${code}`,
  };
}

const HEADER = {
  id: 'test/system-membership.ifcx',
  ifcxVersion: 'ifcx_alpha',
  dataVersion: '1.0.0',
};

describe('parseIfcx — bsi::ifc::system::partofsystem membership', () => {
  it('emits AssignsToGroup edges (group -> member) for partofsystem refs', async () => {
    const doc = {
      header: HEADER,
      imports: [],
      schemas: {},
      data: [
        { path: 'system-1', attributes: { [ATTR.CLASS]: ifcClass('IfcDistributionSystem') } },
        {
          path: 'pipe-1',
          attributes: {
            [ATTR.CLASS]: ifcClass('IfcPipeSegment'),
            // Array-of-refs form (what the buildingSMART samples author).
            [ATTR.PART_OF_SYSTEM]: [{ ref: 'system-1' }],
          },
        },
        {
          path: 'valve-1',
          attributes: {
            [ATTR.CLASS]: ifcClass('IfcValve'),
            // Single bare object form — tolerated defensively.
            [ATTR.PART_OF_SYSTEM]: { ref: 'system-1' },
          },
        },
        {
          path: 'boiler-1',
          attributes: {
            [ATTR.CLASS]: ifcClass('IfcBoiler'),
            // Dangling ref (target node has no entity) — must be skipped,
            // not crash or fabricate an edge.
            [ATTR.PART_OF_SYSTEM]: [{ ref: 'no-such-node' }],
          },
        },
      ],
    };

    const result = await parseIfcx(toBuffer(doc));
    const systemId = result.pathToId.get('system-1')!;
    const pipeId = result.pathToId.get('pipe-1')!;
    const valveId = result.pathToId.get('valve-1')!;
    const boilerId = result.pathToId.get('boiler-1')!;

    const members = result.relationships
      .getRelated(systemId, RelationshipType.AssignsToGroup, 'forward')
      .sort((a, b) => a - b);
    assert.deepStrictEqual(members, [pipeId, valveId].sort((a, b) => a - b));

    // Inverse direction: the member's groups (the properties-panel card path).
    assert.deepStrictEqual(
      result.relationships.getRelated(pipeId, RelationshipType.AssignsToGroup, 'inverse'),
      [systemId],
    );
    assert.deepStrictEqual(
      result.relationships.getRelated(boilerId, RelationshipType.AssignsToGroup, 'inverse'),
      [],
      'a dangling ref yields no edge',
    );
  });
});
