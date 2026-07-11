/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import type { IfcxFile, IfcxNode } from './types.js';
import { IFCLITE_ATTR } from './types.js';
import {
  canonicalStringify,
  canonicalizeLayer,
  computeLayerId,
  computeStackHash,
  blake3Digest,
} from './canonical.js';
import { createProvenanceManifest, setProvenance, validateProvenance, getProvenance } from './provenance.js';

function makeFile(data: IfcxNode[]): IfcxFile {
  return {
    header: {
      id: 'layer-a',
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

describe('canonicalStringify', () => {
  it('sorts object keys and strips whitespace', () => {
    assert.strictEqual(canonicalStringify({ b: 1, a: { d: 2, c: 3 } }), '{"a":{"c":3,"d":2},"b":1}');
  });

  it('normalizes strings to NFC and -0 to 0', () => {
    const decomposed = 'é'; // é as e + combining acute
    assert.strictEqual(canonicalStringify(decomposed), JSON.stringify('é'));
    assert.strictEqual(canonicalStringify(-0), '0');
  });

  it('rejects pathologically deep nesting with a clean error, not a stack overflow', () => {
    let deep: unknown = 1;
    for (let i = 0; i < 100_000; i++) deep = [deep];
    assert.throws(() => canonicalStringify(deep), /nested deeper than/);
  });

  it('drops undefined object members and rejects non-finite numbers', () => {
    assert.strictEqual(canonicalStringify({ a: undefined, b: 1 }), '{"b":1}');
    assert.throws(() => canonicalStringify(Number.POSITIVE_INFINITY));
  });
});

describe('computeLayerId', () => {
  it('is order-independent over node and key ordering', () => {
    const a = makeFile([
      { path: 'wall-1', attributes: { Name: 'W1', FireRating: 'REI90' } },
      { path: 'door-1', attributes: { Name: 'D1' } },
    ]);
    const b = makeFile([
      { path: 'door-1', attributes: { Name: 'D1' } },
      { path: 'wall-1', attributes: { FireRating: 'REI90', Name: 'W1' } },
    ]);
    assert.strictEqual(computeLayerId(a), computeLayerId(b));
    assert.ok(computeLayerId(a).startsWith('blake3:'));
  });

  it('preserves same-path opinion order: opposite orders hash differently', () => {
    // Composition applies same-path nodes in array order (later wins), so
    // [REI60, REI90] and [REI90, REI60] are different states.
    const a = makeFile([
      { path: 'wall-1', attributes: { FireRating: 'REI60' } },
      { path: 'wall-1', attributes: { FireRating: 'REI90' } },
    ]);
    const b = makeFile([
      { path: 'wall-1', attributes: { FireRating: 'REI90' } },
      { path: 'wall-1', attributes: { FireRating: 'REI60' } },
    ]);
    assert.notStrictEqual(computeLayerId(a), computeLayerId(b));
    // Still deterministic for identical input.
    assert.strictEqual(computeLayerId(a), computeLayerId(makeFile(a.data)));
  });

  it('changes when an opinion changes', () => {
    const a = makeFile([{ path: 'wall-1', attributes: { Name: 'W1' } }]);
    const b = makeFile([{ path: 'wall-1', attributes: { Name: 'W2' } }]);
    assert.notStrictEqual(computeLayerId(a), computeLayerId(b));
  });

  it('ignores derived (cache) content', () => {
    const plain = makeFile([{ path: 'wall-1', attributes: { Name: 'W1' } }]);
    const withDerived = makeFile([
      { path: 'wall-1', attributes: { Name: 'W1', [`${IFCLITE_ATTR.DERIVED}::bvh`]: 'cafe' } },
      { path: 'mesh-cache-1', attributes: { [IFCLITE_ATTR.DERIVED]: true, blob: 'beef' } },
    ]);
    assert.strictEqual(computeLayerId(plain), computeLayerId(withDerived));
  });

  it('includes the manifest except signatures', () => {
    const base = makeFile([{ path: 'wall-1', attributes: { Name: 'W1' } }]);
    const manifest = createProvenanceManifest({
      author: { kind: 'human', principal: 'louis@lt.plus' },
      intent: 'test layer',
      base: null,
      created: '2026-06-09T00:00:00Z',
    });
    const signed = setProvenance(base, {
      ...manifest,
      signatures: [{ alg: 'ed25519', key: 'k', sig: 's' }],
    });
    const unsigned = setProvenance(base, manifest);

    assert.notStrictEqual(computeLayerId(base), computeLayerId(unsigned), 'manifest must be hashed');
    assert.strictEqual(computeLayerId(signed), computeLayerId(unsigned), 'signatures must not be hashed');
  });

  it('is stable across serialization round-trips (cross-adapter byte identity)', () => {
    const file = makeFile([{ path: 'wall-1', attributes: { Name: 'Wé', Height: 2.5 } }]);
    const roundTripped = JSON.parse(JSON.stringify(file)) as IfcxFile;
    assert.deepStrictEqual(canonicalizeLayer(file), canonicalizeLayer(roundTripped));
    assert.strictEqual(computeLayerId(file), computeLayerId(roundTripped));
  });
});

describe('computeStackHash', () => {
  it('depends on layer order', () => {
    const x = computeStackHash(['blake3:aa', 'blake3:bb']);
    const y = computeStackHash(['blake3:bb', 'blake3:aa']);
    assert.notStrictEqual(x, y);
    assert.strictEqual(x, computeStackHash(['blake3:aa', 'blake3:bb']));
  });
});

describe('provenance manifest', () => {
  it('round-trips through setProvenance/getProvenance', () => {
    const manifest = createProvenanceManifest({
      author: { kind: 'agent', principal: 'gardener@ltplus.ch', tool: '@ifc-lite/mcp@0.4.0' },
      intent: 'Reclassify load-bearing walls per fire-safety Pset configuration',
      base: { kind: 'stack', id: blake3Digest('stack') },
      scope_claim: ['model.mutate:Pset_FireSafety*@IfcWall&storey=EG'],
    });
    const file = setProvenance(makeFile([]), manifest);
    assert.deepStrictEqual(getProvenance(file), manifest);
    assert.strictEqual(validateProvenance(manifest).length, 0);
  });

  it('rejects manifests without intent, bad author kinds, and bad base ids', () => {
    const good = createProvenanceManifest({
      author: { kind: 'human', principal: 'louis@lt.plus' },
      intent: 'ok',
      base: null,
    });
    assert.ok(validateProvenance({ ...good, intent: '  ' }).length > 0);
    assert.ok(validateProvenance({ ...good, author: { kind: 'robot', principal: 'x' } }).length > 0);
    assert.ok(validateProvenance({ ...good, base: { kind: 'layer', id: 'sha256:nope' } }).length > 0);
    assert.throws(() =>
      createProvenanceManifest({
        author: { kind: 'human', principal: 'louis@lt.plus' },
        intent: '',
        base: null,
      })
    );
  });
});
