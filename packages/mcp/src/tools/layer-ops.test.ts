/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `deriveLayerDescriptors` / `verifyLayerAgainstClaims` claim the same
 * mapping as the CLI's `deriveScopeOps` (see `layer-publish.ts`'s own test
 * "hierarchy-only mutations do not bypass scope enforcement"). This pins
 * that a published layer that only reparents an entity (children/inherits,
 * no attribute edits) is still treated as an op requiring scope coverage —
 * exactly like the CLI path already guarantees.
 */

import { describe, expect, it } from 'vitest';
import type { IfcxFile } from '@ifc-lite/ifcx';
import { deriveLayerDescriptors, verifyLayerAgainstClaims } from './layer-ops.js';

const CLASS = 'bsi::ifc::class';

function layer(data: IfcxFile['data'], id = 'l'): IfcxFile {
  return {
    header: {
      id,
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

const baseFile = layer([
  { path: 'storey-eg', children: { Wall: 'wall-1' } },
  { path: 'wall-1', attributes: { [CLASS]: { code: 'IfcWall', uri: 'u' } } },
  { path: 'wall-2', attributes: { [CLASS]: { code: 'IfcWall', uri: 'u' } } },
]);

describe('deriveLayerDescriptors', () => {
  it('derives a model.mutate:children op for a reparent with no attribute edits', () => {
    const published = layer([{ path: 'storey-eg', children: { Wall: 'wall-2' } }]);
    const ops = deriveLayerDescriptors(published, [baseFile]);
    expect(ops).toEqual([{ path: 'storey-eg', capability: 'model.mutate:children' }]);
  });

  it('does not report an op for an unchanged children echo', () => {
    const published = layer([{ path: 'storey-eg', children: { Wall: 'wall-1' } }]);
    expect(deriveLayerDescriptors(published, [baseFile])).toEqual([]);
  });
});

describe('verifyLayerAgainstClaims', () => {
  it('hierarchy-only mutations do not bypass scope enforcement', () => {
    // Reparent only — no attribute edits at all — under a claim that only
    // covers property mutations.
    const published = layer([{ path: 'storey-eg', children: { Wall: 'wall-2' } }]);
    const verification = verifyLayerAgainstClaims(published, [baseFile], ['model.mutate:Pset_FireSafety*']);
    expect(verification.verified).toBe(false);
    expect(verification.mismatches).toEqual([{ path: 'storey-eg', capability: 'model.mutate:children' }]);
  });
});
