/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { beforeEach, describe, expect, it } from 'vitest';
import { createCollabDoc, entityToJSON, getEntity } from '@ifc-lite/collab';
import { computeStackHash } from '@ifc-lite/ifcx';
import type { IfcxFile } from '@ifc-lite/ifcx';
import {
  createLayerWorkspace,
  refLayerFiles,
  resolveAncestorFiles,
  resolveBase,
  seedDraftDoc,
  type LayerWorkspace,
} from './layer-store.js';

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

  it('resurrected entities keep their base state (tombstones resolve after all layers)', () => {
    const doc = createCollabDoc({ gc: false });
    seedDraftDoc(doc, [
      layer([
        {
          path: 'wall-1',
          attributes: { 'bsi::ifc::class': { code: 'IfcWall', uri: 'u' }, Name: 'W1' },
        },
      ]),
      layer([{ path: 'wall-1', attributes: { 'ifclite::deleted': true } }]),
      layer([{ path: 'wall-1', attributes: { 'ifclite::deleted': false } }]),
    ]);

    const wall = getEntity(doc, 'wall-1');
    expect(wall).toBeTruthy();
    const json = wall && entityToJSON(wall);
    expect(json?.attributes?.['Name']).toBe('W1');
    expect(json?.attributes?.['bsi::ifc::class']).toEqual({ code: 'IfcWall', uri: 'u' });
  });

  it('deletes entities whose strongest tombstone opinion is true, even if later layers touch them', () => {
    const doc = createCollabDoc({ gc: false });
    seedDraftDoc(doc, [
      layer([{ path: 'wall-1', attributes: { Name: 'W1' } }]),
      layer([{ path: 'wall-1', attributes: { 'ifclite::deleted': true } }]),
      // No resurrect opinion: composition removes the node regardless of
      // this layer's attribute write.
      layer([{ path: 'wall-1', attributes: { Name: 'W2' } }]),
    ]);

    expect(getEntity(doc, 'wall-1')).toBeFalsy();
  });
});

/**
 * `resolveBase` decides what provenance a draft records and what baseline it is
 * seeded from. Its `ProvenanceBase.kind` is not cosmetic: `resolveAncestorFiles`
 * dispatches on it — a `'stack'` base is matched against a *stack hash* of a ref
 * prefix, a `'layer'` base against a *layer id*. Only `seedDraftDoc` had tests,
 * so `{ kind: 'layer', id: ref }` could be written as `{ kind: 'stack', id: ref }`
 * with the suite green, and every draft seeded from a published layer would then
 * resolve to an empty ancestor set: the draft is silently rebased onto nothing,
 * and the merge planner is handed the wrong baseline.
 */
describe('resolveBase', () => {
  let ws: LayerWorkspace;
  let a: IfcxFile;
  let b: IfcxFile;

  beforeEach(() => {
    ws = createLayerWorkspace();
    a = layer([{ path: 'wall-1', attributes: { Name: 'A' } }], 'layer-a');
    b = layer([{ path: 'wall-1', attributes: { Name: 'B' } }], 'layer-b');
    ws.layers.set('layer-a', a);
    ws.layers.set('layer-b', b);
    ws.refs.set('main', ['layer-a', 'layer-b']);
  });

  it('records no base when no ref is asked for', () => {
    expect(resolveBase(ws)).toEqual({ base: null, files: [] });
  });

  it('records a stack base for a ref name, hashed over the ref contents', () => {
    const out = resolveBase(ws, 'main');
    expect(out.base).toEqual({ kind: 'stack', id: computeStackHash(['layer-a', 'layer-b']) });
    expect(out.files).toEqual([a, b]);
  });

  it('records an empty ref as no base at all, not as a stack of nothing', () => {
    ws.refs.set('empty', []);
    expect(resolveBase(ws, 'empty')).toEqual({ base: null, files: [] });
  });

  it('records a *layer* base for a published layer id, and seeds the whole ancestor stack', () => {
    const out = resolveBase(ws, 'layer-a');
    // `kind` is the load-bearing half: a 'stack' base carrying a layer id
    // resolves through the stack-hash arm of `resolveAncestorFiles` and finds
    // nothing, because a layer id is not a stack hash.
    expect(out.base).toEqual({ kind: 'layer', id: 'layer-a' });
    // Seeded from the ancestor prefix ending at that layer, not the lone delta.
    expect(out.files).toEqual([a]);
    // The property that makes `kind` observable, asserted directly.
    expect(resolveAncestorFiles(ws, out.base, ['layer-a', 'layer-b'])).toEqual([a]);
    expect(resolveAncestorFiles(ws, { kind: 'stack', id: 'layer-a' }, ['layer-a', 'layer-b'])).toEqual([]);
  });

  it('seeds the full prefix when the layer sits mid-history', () => {
    const out = resolveBase(ws, 'layer-b');
    expect(out.base).toEqual({ kind: 'layer', id: 'layer-b' });
    expect(out.files).toEqual([a, b]);
  });

  it('falls back to the lone layer when it belongs to no ref', () => {
    const stray = layer([{ path: 'wall-9', attributes: { Name: 'S' } }], 'stray');
    ws.layers.set('stray', stray);
    const out = resolveBase(ws, 'stray');
    expect(out.base).toEqual({ kind: 'layer', id: 'stray' });
    expect(out.files).toEqual([stray]);
  });

  it('rejects a base that is neither a ref name nor a published layer id', () => {
    expect(() => resolveBase(ws, 'nope')).toThrow(/not a ref name or published layer id/);
  });
});

describe('refLayerFiles', () => {
  it('errors on an unknown ref rather than answering an empty stack', () => {
    const ws = createLayerWorkspace();
    expect(() => refLayerFiles(ws, 'nope')).toThrow(/Unknown ref/);
    // `main` exists and is empty — a genuinely empty stack is not an error.
    expect(refLayerFiles(ws, 'main')).toEqual([]);
  });

  it('errors on a ref pointing at a layer that is no longer stored', () => {
    const ws = createLayerWorkspace();
    ws.refs.set('main', ['ghost']);
    expect(() => refLayerFiles(ws, 'main')).toThrow(/points at unknown layer ghost/);
  });
});
