/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The shared bridge helpers had no test file. `toRef` has 30+ call sites
 * across the bridge namespaces and is the only thing standing between a
 * script-supplied object and an EntityRef the SDK will act on; `withAliases`
 * exists solely so scripts can write `e.GlobalId` as well as `e.globalId`.
 *
 * Dropping `toRef`'s shape validation, and dropping an alias from
 * `withAliases`, both left the package suite green.
 */

import { describe, expect, it } from 'vitest';
import type { EntityData } from '@ifc-lite/sdk';
import { mapNamedProperties, toRef, withAliases } from './bridge-helpers.js';

describe('toRef', () => {
  it('accepts a wrapped ref', () => {
    expect(toRef({ ref: { modelId: 'm1', expressId: 42 }, name: 'Wall' })).toEqual({
      modelId: 'm1',
      expressId: 42,
    });
  });

  it('accepts a bare ref', () => {
    expect(toRef({ modelId: 'm1', expressId: 42 })).toEqual({ modelId: 'm1', expressId: 42 });
  });

  it('rejects a wrapped ref whose fields have the wrong types', () => {
    // A script can hand any shape across the boundary. Each of these has a
    // `ref` object, so a validation-free version would return it and let the
    // SDK act on a ref with no usable expressId.
    expect(toRef({ ref: { modelId: 'm1', expressId: '42' } })).toBeNull();
    expect(toRef({ ref: { modelId: 1, expressId: 42 } })).toBeNull();
    expect(toRef({ ref: { modelId: 'm1' } })).toBeNull();
    expect(toRef({ ref: { expressId: 42 } })).toBeNull();
    expect(toRef({ ref: {} })).toBeNull();
  });

  it('rejects a bare object whose fields have the wrong types', () => {
    expect(toRef({ modelId: 'm1', expressId: '42' })).toBeNull();
    expect(toRef({ modelId: 42, expressId: 42 })).toBeNull();
    expect(toRef({ name: 'Wall' })).toBeNull();
  });

  it('rejects nullish and non-object input', () => {
    expect(toRef(null)).toBeNull();
    expect(toRef(undefined)).toBeNull();
    expect(toRef(0)).toBeNull();
    expect(toRef('')).toBeNull();
  });

  it('prefers the wrapped ref over sibling fields when both are present', () => {
    expect(
      toRef({ ref: { modelId: 'inner', expressId: 1 }, modelId: 'outer', expressId: 2 }),
    ).toEqual({ modelId: 'inner', expressId: 1 });
  });

  it('falls back to the bare fields when the wrapped ref is unusable', () => {
    // The fallback returns the OUTER object itself (extra keys and all), not a
    // freshly built ref — so assert the identifying fields rather than an
    // exact shape.
    expect(toRef({ ref: { modelId: 'inner' }, modelId: 'outer', expressId: 2 })).toMatchObject({
      modelId: 'outer',
      expressId: 2,
    });
  });
});

describe('withAliases', () => {
  const entity = {
    ref: { modelId: 'm1', expressId: 7 },
    globalId: '0YvCT2_$X3_xJG3rzD8L_8',
    name: 'Basic Wall',
    type: 'IfcWall',
    description: 'exterior',
    objectType: 'Wall:Basic',
  } as unknown as EntityData;

  it('exposes every field under BOTH the camelCase and PascalCase spelling', () => {
    const aliased = withAliases(entity);
    // Enumerated as an exact shape: a missing alias is the whole failure mode,
    // and spot-checking one pair would not catch a different one going away.
    expect(aliased).toEqual({
      ref: { modelId: 'm1', expressId: 7 },
      globalId: '0YvCT2_$X3_xJG3rzD8L_8',
      GlobalId: '0YvCT2_$X3_xJG3rzD8L_8',
      name: 'Basic Wall',
      Name: 'Basic Wall',
      type: 'IfcWall',
      Type: 'IfcWall',
      description: 'exterior',
      Description: 'exterior',
      objectType: 'Wall:Basic',
      ObjectType: 'Wall:Basic',
    });
  });

  it('keeps the two spellings SYMMETRIC — every attribute has both, carrying one value (#2422)', () => {
    // The exact-shape test above pins today's six attributes. This pins the
    // invariant that made #2422 resolve as "keep both": a script may reach any
    // attribute under either spelling and get the same answer. A seventh
    // attribute added under only one spelling, or an alias wired to the wrong
    // source field, would satisfy the exact-shape test after a routine update
    // and still break the promise `bim-globals.d.ts` makes to script authors.
    const aliased = withAliases(entity);
    const camel = Object.keys(aliased).filter((k) => k !== 'ref' && k[0] === k[0]?.toLowerCase());
    expect(camel.length).toBeGreaterThan(0);
    for (const key of camel) {
      const pascal = key[0]!.toUpperCase() + key.slice(1);
      expect(Object.keys(aliased)).toContain(pascal);
      expect(aliased[pascal]).toBe(aliased[key]);
    }
    // ...and nothing is PascalCase-only either.
    const pascalOnly = Object.keys(aliased).filter(
      (k) => k[0] === k[0]?.toUpperCase() && !(k[0]!.toLowerCase() + k.slice(1) in aliased),
    );
    expect(pascalOnly).toEqual([]);
  });

  it('carries an absent field through as undefined under both spellings', () => {
    const sparse = { ref: { modelId: 'm1', expressId: 7 }, name: 'Wall' } as unknown as EntityData;
    const aliased = withAliases(sparse);
    expect(Object.keys(aliased).sort()).toEqual(
      [
        'Description',
        'GlobalId',
        'Name',
        'ObjectType',
        'Type',
        'description',
        'globalId',
        'name',
        'objectType',
        'ref',
        'type',
      ].sort(),
    );
    expect(aliased.GlobalId).toBeUndefined();
    expect(aliased.Name).toBe('Wall');
  });
});

describe('mapNamedProperties', () => {
  it('exposes each property under every spelling the schema promises', () => {
    expect(
      mapNamedProperties([{ name: 'IsExternal', value: true, type: 'IfcBoolean' }]),
    ).toEqual([
      {
        name: 'IsExternal',
        Name: 'IsExternal',
        value: true,
        Value: true,
        NominalValue: true,
        type: 'IfcBoolean',
        Type: 'IfcBoolean',
      },
    ]);
  });

  it('maps every entry, not just the first', () => {
    const mapped = mapNamedProperties([
      { name: 'A', value: 1, type: 'IfcInteger' },
      { name: 'B', value: 2, type: 'IfcInteger' },
    ]);
    expect(mapped.map((p) => p.Name)).toEqual(['A', 'B']);
    expect(mapped.map((p) => p.NominalValue)).toEqual([1, 2]);
  });

  it('returns an empty list for no properties', () => {
    expect(mapNamedProperties([])).toEqual([]);
  });
});
