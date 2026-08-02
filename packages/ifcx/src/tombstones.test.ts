/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import type { IfcxFile, IfcxNode } from './types.js';
import { IFCLITE_ATTR } from './types.js';
import { composeIfcx } from './composition.js';
import { composeFederated } from './federated-composition.js';
import { createLayerStack } from './layer-stack.js';
import { bakeLayers } from './bake.js';

function makeFile(data: IfcxNode[], id = 'test'): IfcxFile {
  return {
    header: {
      id,
      ifcxVersion: 'ifcx-alpha',
      dataVersion: '1',
      author: 'test',
      timestamp: '2026-06-09T00:00:00Z',
    },
    imports: [],
    schemas: {},
    data,
  };
}

const baseNodes: IfcxNode[] = [
  {
    path: 'storey-eg',
    children: { Wall: 'wall-1', Door: 'door-1' },
    attributes: { 'bsi::ifc::class': { code: 'IfcBuildingStorey', uri: 'u' } },
  },
  {
    path: 'wall-1',
    children: { Opening: 'opening-1' },
    attributes: { 'bsi::ifc::class': { code: 'IfcWall', uri: 'u' }, 'bsi::ifc::prop::Name': 'W1' },
  },
  { path: 'opening-1', attributes: { 'bsi::ifc::class': { code: 'IfcOpeningElement', uri: 'u' } } },
  { path: 'door-1', attributes: { 'bsi::ifc::class': { code: 'IfcDoor', uri: 'u' } } },
];

describe('tombstone composition (single document, later wins)', () => {
  it('removes a tombstoned entity and its subtree, and detaches it from parents', () => {
    const file = makeFile([
      ...baseNodes,
      { path: 'wall-1', attributes: { [IFCLITE_ATTR.DELETED]: true } },
    ]);
    const composed = composeIfcx(file);

    assert.strictEqual(composed.has('wall-1'), false, 'tombstoned entity composed');
    assert.strictEqual(composed.has('opening-1'), false, 'child path not shadowed');
    assert.strictEqual(composed.has('door-1'), true, 'sibling must survive');
    const storey = composed.get('storey-eg');
    assert.ok(storey);
    assert.strictEqual(storey.children.has('Wall'), false, 'parent still references deleted child');
    assert.strictEqual(storey.children.has('Door'), true);
  });

  it('resurrects when a later opinion sets ifclite::deleted false, stripping the marker', () => {
    const file = makeFile([
      ...baseNodes,
      { path: 'wall-1', attributes: { [IFCLITE_ATTR.DELETED]: true } },
      { path: 'wall-1', attributes: { [IFCLITE_ATTR.DELETED]: false } },
    ]);
    const composed = composeIfcx(file);

    const wall = composed.get('wall-1');
    assert.ok(wall, 'resurrected entity missing');
    assert.strictEqual(wall.attributes.get('bsi::ifc::prop::Name'), 'W1');
    assert.strictEqual(wall.attributes.has(IFCLITE_ATTR.DELETED), false, 'marker leaked');
    assert.strictEqual(composed.has('opening-1'), true);
  });

  it('leaves documents without tombstones untouched', () => {
    const composed = composeIfcx(makeFile(baseNodes));
    assert.strictEqual(composed.size, 4);
  });
});

describe('tombstone composition (federated layer stack, strength wins)', () => {
  function stackOf(files: IfcxFile[]) {
    // addLayerAt position 0 makes later files stronger (parseFederatedIfcx pattern).
    const stack = createLayerStack();
    files.forEach((file, i) => {
      const buffer = new ArrayBuffer(0);
      stack.addLayerAt(file, buffer, `layer-${i}`, 0, { type: 'buffer', name: `layer-${i}` });
    });
    return stack;
  }

  it('a tombstone layer shadows weaker opinions including child paths', () => {
    const stack = stackOf([
      makeFile(baseNodes, 'base'),
      makeFile([{ path: 'wall-1', attributes: { [IFCLITE_ATTR.DELETED]: true } }], 'delete-wall'),
    ]);
    const { composed, roots } = composeFederated(stack);

    assert.strictEqual(composed.has('wall-1'), false);
    assert.strictEqual(composed.has('opening-1'), false);
    assert.strictEqual(composed.has('door-1'), true);
    assert.ok(roots.every((root) => root.path !== 'wall-1'));
  });

  it('a stronger revert layer resurrects a tombstoned entity', () => {
    const stack = stackOf([
      makeFile(baseNodes, 'base'),
      makeFile([{ path: 'wall-1', attributes: { [IFCLITE_ATTR.DELETED]: true } }], 'delete-wall'),
      makeFile([{ path: 'wall-1', attributes: { [IFCLITE_ATTR.DELETED]: false } }], 'revert'),
    ]);
    const { composed } = composeFederated(stack);

    const wall = composed.get('wall-1');
    assert.ok(wall, 'resurrected entity missing');
    assert.strictEqual(wall.attributes.get('bsi::ifc::prop::Name'), 'W1');
    assert.strictEqual(composed.has('opening-1'), true);
  });

  it('weaker tombstones lose to stronger opinions only via explicit resurrect', () => {
    // Stronger layer edits a Pset but does not resurrect: deletion still wins.
    const stack = stackOf([
      makeFile(baseNodes, 'base'),
      makeFile([{ path: 'wall-1', attributes: { [IFCLITE_ATTR.DELETED]: true } }], 'delete-wall'),
      makeFile([{ path: 'wall-1', attributes: { 'bsi::ifc::prop::FireRating': 'REI90' } }], 'edit'),
    ]);
    const { composed } = composeFederated(stack);
    assert.strictEqual(composed.has('wall-1'), false);
  });
});

describe('null attribute opinions compose as removals (#1031)', () => {
  const removalStack = [
    makeFile(baseNodes, 'base'),
    makeFile(
      [
        {
          path: 'wall-1',
          attributes: {
            'bsi::ifc::prop::Name': null,
            'bsi::ifc::v5a::Pset_FireSafety::FireRating': null,
          },
        },
      ],
      'remove'
    ),
  ];

  it('composeIfcx deletes null-valued attributes', () => {
    const merged: IfcxFile = {
      ...removalStack[0],
      data: removalStack.flatMap((file) => file.data),
    };
    const composed = composeIfcx(merged);
    const wall = composed.get('wall-1');
    assert.ok(wall);
    assert.strictEqual(wall.attributes.has('bsi::ifc::prop::Name'), false);
    assert.strictEqual(wall.attributes.has('bsi::ifc::v5a::Pset_FireSafety::FireRating'), false);
  });

  it('composeFederated deletes null-valued attributes', () => {
    const stack = createLayerStack();
    removalStack.forEach((file, i) => {
      // addLayerAt position 0 makes later files stronger (parseFederatedIfcx pattern).
      stack.addLayerAt(file, new ArrayBuffer(0), `layer-${i}`, 0, { type: 'buffer', name: `layer-${i}` });
    });
    const { composed } = composeFederated(stack);
    const wall = composed.get('wall-1');
    assert.ok(wall);
    assert.strictEqual(wall.attributes.has('bsi::ifc::prop::Name'), false);
  });

  it('a later non-null opinion resurrects a removed attribute', () => {
    const merged: IfcxFile = {
      ...removalStack[0],
      data: [
        ...removalStack.flatMap((file) => file.data),
        { path: 'wall-1', attributes: { 'bsi::ifc::prop::Name': 'W1-renamed' } },
      ],
    };
    const composed = composeIfcx(merged);
    assert.strictEqual(composed.get('wall-1')?.attributes.get('bsi::ifc::prop::Name'), 'W1-renamed');
  });

  it('null removals mask INHERITED attributes too (both composers)', () => {
    const inheritedRemoval: IfcxNode[] = [
      { path: 'wall-type', attributes: { 'bsi::ifc::prop::FireRating': 'REI30' } },
      { path: 'wall-9', inherits: { Type: 'wall-type' }, attributes: { 'bsi::ifc::prop::Name': 'W9' } },
      // Stronger opinion removes the inherited value on the instance.
      { path: 'wall-9', attributes: { 'bsi::ifc::prop::FireRating': null } },
    ];

    const composed = composeIfcx(makeFile(inheritedRemoval, 'inherit-removal'));
    const wall = composed.get('wall-9');
    assert.ok(wall);
    assert.strictEqual(wall.attributes.has('bsi::ifc::prop::FireRating'), false, 'composeIfcx');
    assert.strictEqual(wall.attributes.get('bsi::ifc::prop::Name'), 'W9');

    const stack = createLayerStack();
    stack.addLayerAt(
      makeFile(inheritedRemoval, 'inherit-removal'),
      new ArrayBuffer(0),
      'layer-0',
      0,
      { type: 'buffer', name: 'layer-0' }
    );
    const federated = composeFederated(stack);
    const fedWall = federated.composed.get('wall-9');
    assert.ok(fedWall);
    assert.strictEqual(fedWall.attributes.has('bsi::ifc::prop::FireRating'), false, 'composeFederated');
  });
});

describe('bakeLayers (tombstone-free materialization)', () => {
  it('emits a flat document with deletions resolved and no ifclite:: attributes', () => {
    const baked = bakeLayers([
      makeFile(baseNodes, 'base'),
      makeFile([{ path: 'wall-1', attributes: { [IFCLITE_ATTR.DELETED]: true } }], 'delete-wall'),
    ]);

    const paths = baked.data.map((node) => node.path);
    assert.deepStrictEqual(paths, ['door-1', 'storey-eg']);
    for (const node of baked.data) {
      for (const key of Object.keys(node.attributes ?? {})) {
        assert.ok(!key.startsWith('ifclite::'), `ifclite attribute leaked: ${key}`);
      }
    }
    const storey = baked.data.find((node) => node.path === 'storey-eg');
    assert.deepStrictEqual(storey?.children, { Door: 'door-1' });
  });

  it('strips bookkeeping but preserves persistent ifclite:: data carriers (#1031)', () => {
    const baked = bakeLayers([
      makeFile(
        [
          {
            path: 'wall-1',
            attributes: {
              'bsi::ifc::prop::Name': 'W1',
              'ifclite::classifications': [{ system: 'eBKP-H', code: 'C2.1' }],
              'ifclite::materials': [{ materialId: 'mat-1' }],
              'ifclite::geometryRef': 'geom-1',
              [IFCLITE_ATTR.DERIVED]: true,
            },
          },
        ],
        'base'
      ),
    ]);

    // Derived nodes are dropped wholesale by canonicalization, not bake;
    // bake strips the marker attribute but keeps the node + carriers.
    const wall = baked.data.find((node) => node.path === 'wall-1');
    assert.ok(wall, 'wall survived bake');
    assert.deepStrictEqual(wall.attributes?.['ifclite::classifications'], [
      { system: 'eBKP-H', code: 'C2.1' },
    ]);
    assert.deepStrictEqual(wall.attributes?.['ifclite::materials'], [{ materialId: 'mat-1' }]);
    assert.strictEqual(wall.attributes?.['ifclite::geometryRef'], 'geom-1');
    assert.ok(!(IFCLITE_ATTR.DERIVED in (wall.attributes ?? {})), 'derived marker stripped');
    assert.ok(!(IFCLITE_ATTR.DELETED in (wall.attributes ?? {})), 'no tombstone in baked output');
  });

  it('round-trips: bake output composes identically to the source stack', () => {
    const stack = [
      makeFile(baseNodes, 'base'),
      makeFile(
        [
          { path: 'door-1', attributes: { 'bsi::ifc::prop::FireRating': 'EI30' } },
          { path: 'opening-1', attributes: { [IFCLITE_ATTR.DELETED]: true } },
        ],
        'changes'
      ),
    ];
    const baked = bakeLayers(stack);
    const reparsed = composeIfcx(JSON.parse(JSON.stringify(baked)) as IfcxFile);

    assert.strictEqual(reparsed.has('opening-1'), false);
    assert.strictEqual(
      reparsed.get('door-1')?.attributes.get('bsi::ifc::prop::FireRating'),
      'EI30'
    );
    const wall = reparsed.get('wall-1');
    assert.ok(wall);
    assert.strictEqual(wall.children.has('Opening'), false);
  });
});
