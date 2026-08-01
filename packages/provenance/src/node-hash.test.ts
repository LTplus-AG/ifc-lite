/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import {
  computeNodeHash,
  hashResolvedNode,
  type ElementPayload,
  type GeometryMeshPayload,
  type LayerPayload,
  type PropertySetPayload,
  type RelationshipPayload,
} from './node-hash.js';

const cubeMesh: GeometryMeshPayload = {
  expressId: 100,
  geometryClass: 0,
  positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1],
  normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
  indices: [0, 1, 2, 0, 2, 3],
  origin: [10, 20, 30],
};

describe('computeNodeHash: geometry-mesh', () => {
  it('is deterministic', async () => {
    const a = await computeNodeHash('geometry-mesh', cubeMesh);
    const b = await computeNodeHash('geometry-mesh', cubeMesh);
    expect(a).toBe(b);
    expect(a).toMatch(/^fnv1a64:0x[0-9a-f]{16}$/);
  });

  it('is sensitive to a single position bit', async () => {
    const base = await computeNodeHash('geometry-mesh', cubeMesh);
    const moved: GeometryMeshPayload = {
      ...cubeMesh,
      positions: [0, 0, 0, 1.0001, 0, 0, 0, 1, 0, 0, 0, 1],
    };
    const changed = await computeNodeHash('geometry-mesh', moved);
    expect(changed).not.toBe(base);
  });

  it('is sensitive to origin (unlike the RTC-invariant diff hash — this one is byte-exact by design)', async () => {
    const base = await computeNodeHash('geometry-mesh', cubeMesh);
    const shifted = await computeNodeHash('geometry-mesh', { ...cubeMesh, origin: [10, 20, 31] });
    expect(shifted).not.toBe(base);
  });

  it('is sensitive to express id, geometry class, and index order', async () => {
    const base = await computeNodeHash('geometry-mesh', cubeMesh);
    expect(await computeNodeHash('geometry-mesh', { ...cubeMesh, expressId: 101 })).not.toBe(base);
    expect(await computeNodeHash('geometry-mesh', { ...cubeMesh, geometryClass: 1 })).not.toBe(base);
    expect(
      await computeNodeHash('geometry-mesh', { ...cubeMesh, indices: [0, 2, 1, 0, 2, 3] }),
    ).not.toBe(base);
  });

  it('normals are actually read (changing only normals changes the hash)', async () => {
    const base = await computeNodeHash('geometry-mesh', cubeMesh);
    const differentNormals = await computeNodeHash('geometry-mesh', {
      ...cubeMesh,
      normals: [0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1],
    });
    expect(differentNormals).not.toBe(base);
  });
});

describe('geometry-mesh domain validation (rejects what the Rust wire types cannot hold)', () => {
  /* The TS port types every mesh field as `number`, but the frozen encoding is
   * u32 / u8 / f32 / f64. Coercing (`v >>> 0`, `& 0xff`, f32 narrowing) instead
   * of rejecting hands out second preimages: distinct payloads with one hash.
   * No golden vector can cover this — a vector pins how an ACCEPTED payload
   * encodes, and the whole point here is which payloads are refused. */
  const reject = (patch: Partial<GeometryMeshPayload>) =>
    expect(computeNodeHash('geometry-mesh', { ...cubeMesh, ...patch })).rejects.toThrow(
      /out of domain/,
    );

  it('rejects a non-integer or out-of-u32-range expressId (100 !== 100.9 !== 100 + 2**32)', async () => {
    await reject({ expressId: 100.9 });
    await reject({ expressId: 100 + 2 ** 32 });
    await reject({ expressId: -1 });
    // The u32 bounds themselves stay in-domain.
    await expect(
      computeNodeHash('geometry-mesh', { ...cubeMesh, expressId: 0xffffffff }),
    ).resolves.toMatch(/^fnv1a64:/);
  });

  it('rejects a geometryClass outside [0, 255] (1 !== 257 !== -255)', async () => {
    await reject({ geometryClass: 257 });
    await reject({ geometryClass: -255 });
    await reject({ geometryClass: 1.5 });
    await expect(
      computeNodeHash('geometry-mesh', { ...cubeMesh, geometryClass: 255 }),
    ).resolves.toMatch(/^fnv1a64:/);
  });

  it('rejects non-integer and negative indices ([0,1,2] !== [0,1.75,2]; [-1] !== [4294967295])', async () => {
    await reject({ indices: [0, 1.75, 2] });
    await reject({ indices: [-1] });
    await expect(
      computeNodeHash('geometry-mesh', { ...cubeMesh, indices: [4294967295] }),
    ).resolves.toMatch(/^fnv1a64:/);
  });

  it('rejects an ArrayLike with holes instead of hashing it as all-NaN', async () => {
    await reject({ positions: { length: 3 } as unknown as number[] });
    await reject({ normals: { length: 3 } as unknown as number[] });
  });

  it('rejects NaN/Infinity positions and finite doubles with no f32 (1e39 !== 1e40)', async () => {
    await reject({ positions: [NaN, 0, 0] });
    await reject({ positions: [Infinity, 0, 0] });
    await reject({ positions: [1e39, 0, 0] });
    await reject({ positions: [1e40, 0, 0] });
    await reject({ normals: [0, 0, -Infinity] });
    // In-range f32 narrowing is inherent to the frozen format and stays allowed.
    await expect(
      computeNodeHash('geometry-mesh', { ...cubeMesh, positions: [3.4e38, 0, 0] }),
    ).resolves.toMatch(/^fnv1a64:/);
  });

  it('rejects a non-finite or wrong-length origin', async () => {
    await reject({ origin: [NaN, 0, 0] as unknown as [number, number, number] });
    await reject({ origin: [0, Infinity, 0] as unknown as [number, number, number] });
    await reject({ origin: [0, 0] as unknown as [number, number, number] });
  });

  it('leaves every in-domain payload byte-identical (validation is a gate, not an encoding)', async () => {
    expect(await computeNodeHash('geometry-mesh', cubeMesh)).toBe(
      await computeNodeHash('geometry-mesh', { ...cubeMesh }),
    );
  });
});

describe('computeNodeHash: property-set', () => {
  const pset: PropertySetPayload = {
    name: 'Pset_WallCommon',
    properties: [
      { name: 'IsExternal', value: true },
      { name: 'FireRating', value: 'REI60' },
      { name: 'ThermalTransmittance', value: 0.24 },
    ],
  };

  it('is deterministic and order-independent (property order does not affect the hash)', async () => {
    const a = await computeNodeHash('property-set', pset);
    const reordered: PropertySetPayload = {
      name: pset.name,
      properties: [...pset.properties].reverse(),
    };
    const b = await computeNodeHash('property-set', reordered);
    expect(a).toBe(b);
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('detects a changed property value', async () => {
    const a = await computeNodeHash('property-set', pset);
    const tampered: PropertySetPayload = {
      name: pset.name,
      properties: pset.properties.map((p) => (p.name === 'IsExternal' ? { ...p, value: false } : p)),
    };
    expect(await computeNodeHash('property-set', tampered)).not.toBe(a);
  });

  it('detects an added or removed property', async () => {
    const a = await computeNodeHash('property-set', pset);
    const withExtra: PropertySetPayload = {
      name: pset.name,
      properties: [...pset.properties, { name: 'Combustible', value: false }],
    };
    expect(await computeNodeHash('property-set', withExtra)).not.toBe(a);
  });

  it('distinguishes null from missing/false/empty-string', async () => {
    const nullVal = await computeNodeHash('property-set', {
      name: 'X',
      properties: [{ name: 'A', value: null }],
    });
    const falseVal = await computeNodeHash('property-set', {
      name: 'X',
      properties: [{ name: 'A', value: false }],
    });
    const emptyStr = await computeNodeHash('property-set', {
      name: 'X',
      properties: [{ name: 'A', value: '' }],
    });
    expect(nullVal).not.toBe(falseVal);
    expect(nullVal).not.toBe(emptyStr);
    expect(falseVal).not.toBe(emptyStr);
  });

  it('folds -0 and 0 to the same hash', async () => {
    const zero = await computeNodeHash('property-set', { name: 'X', properties: [{ name: 'A', value: 0 }] });
    const negZero = await computeNodeHash('property-set', {
      name: 'X',
      properties: [{ name: 'A', value: -0 }],
    });
    expect(zero).toBe(negZero);
  });
});

describe('set ordering is NFC-normalized (sort key and encoded key are the same bytes)', () => {
  /* Strings are NFC-normalized when ENCODED, so they must be NFC-normalized
   * when SORTED too. Raw-byte sorting lets the pre-normalization spelling pick
   * the order: NFD "É" (0x45 0xcc 0x81) sorts before "Z", NFC "É" (0xc3 0x89)
   * sorts after — one canonical input, two hashes. That dual is worse than a
   * collision: "recompute and compare" fails on honest data. */
  // Built from code points, never typed as literals: an editor (or a tool)
  // that renormalizes this file must not be able to quietly defuse the test.
  const NFC = `${String.fromCharCode(0x00c9)}paisseur`; // É  (U+00C9)
  const NFD = `E${String.fromCharCode(0x0301)}paisseur`; // E + U+0301 COMBINING ACUTE ACCENT

  it('the two spellings really are distinct strings with the same NFC form', () => {
    expect(NFD).not.toBe(NFC);
    expect(NFD.normalize('NFC')).toBe(NFC);
  });

  it('property-set: a reorderable multi-property payload hashes the same either way', async () => {
    const pset = (name: string): PropertySetPayload => ({
      name: 'Pset_WindowCommon',
      properties: [
        { name, value: 0.24 },
        { name: 'Zone', value: 'A' },
      ],
    });
    expect(await computeNodeHash('property-set', pset(NFD))).toBe(
      await computeNodeHash('property-set', pset(NFC)),
    );
  });

  it('relationship: roleName spelling does not pick the role order', async () => {
    const rel = (roleName: string): RelationshipPayload => ({
      relType: 'IfcRelAggregates',
      roles: [
        { roleName, refs: ['sha256:aaa'] },
        { roleName: 'Zone', refs: ['sha256:bbb'] },
      ],
    });
    expect(await computeNodeHash('relationship', rel(NFD))).toBe(
      await computeNodeHash('relationship', rel(NFC)),
    );
  });

  it('element: componentKey spelling does not pick the component order', async () => {
    const el = (componentKey: string): ElementPayload => ({
      key: '0GlobalId000000000001',
      ifcType: 'IfcWall',
      components: [
        { componentKey, hash: 'sha256:aaa' },
        { componentKey: 'Zone', hash: 'sha256:bbb' },
      ],
    });
    expect(await computeNodeHash('element', el(NFD))).toBe(
      await computeNodeHash('element', el(NFC)),
    );
  });

  it('layer: child-hash refs sort on their normalized bytes', async () => {
    const layer = (id: string): LayerPayload => ({
      layerId: 'blake3:testlayer',
      childHashes: [`sha256:${id}`, 'sha256:Zone'],
    });
    expect(await computeNodeHash('layer', layer(NFD))).toBe(
      await computeNodeHash('layer', layer(NFC)),
    );
  });
});

describe('computeNodeHash: relationship', () => {
  it('is order-independent across roles and refs within a role', async () => {
    const rel: RelationshipPayload = {
      relType: 'IfcRelVoidsElement',
      roles: [
        { roleName: 'RelatingBuildingElement', refs: ['sha256:aaa'] },
        { roleName: 'RelatedOpeningElement', refs: ['sha256:bbb', 'sha256:ccc'] },
      ],
    };
    const reordered: RelationshipPayload = {
      relType: rel.relType,
      roles: [
        { roleName: 'RelatedOpeningElement', refs: ['sha256:ccc', 'sha256:bbb'] },
        { roleName: 'RelatingBuildingElement', refs: ['sha256:aaa'] },
      ],
    };
    expect(await computeNodeHash('relationship', rel)).toBe(await computeNodeHash('relationship', reordered));
  });

  it('detects a changed child reference', async () => {
    const rel: RelationshipPayload = {
      relType: 'IfcRelVoidsElement',
      roles: [{ roleName: 'RelatedOpeningElement', refs: ['sha256:bbb'] }],
    };
    const changed: RelationshipPayload = {
      relType: rel.relType,
      roles: [{ roleName: 'RelatedOpeningElement', refs: ['sha256:zzz'] }],
    };
    expect(await computeNodeHash('relationship', rel)).not.toBe(await computeNodeHash('relationship', changed));
  });
});

describe('geometry-mesh semanticHash annotation (decision Q2)', () => {
  it('does NOT change the node hash: byte-exact primary is the only certified hash', async () => {
    const base = {
      expressId: 100,
      geometryClass: 1,
      positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
      normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
      indices: [0, 1, 2],
      origin: [0, 0, 0] as const,
    };
    const withAnnotation = { ...base, semanticHash: 0x5bd1e995deadbeefn };
    expect(await computeNodeHash('geometry-mesh', withAnnotation)).toBe(
      await computeNodeHash('geometry-mesh', base),
    );
  });
});

describe('computeNodeHash: layer', () => {
  it('embeds the ifcx layerId: a different blake3 identity is a different node hash (decision Q1)', async () => {
    const a: LayerPayload = { layerId: 'blake3:aaaa', childHashes: ['sha256:one'] };
    const b: LayerPayload = { layerId: 'blake3:bbbb', childHashes: ['sha256:one'] };
    expect(await computeNodeHash('layer', a)).not.toBe(await computeNodeHash('layer', b));
  });

  it('is order-independent over child hashes', async () => {
    const a: LayerPayload = { layerId: 'blake3:testlayer', childHashes: ['sha256:one', 'sha256:two', 'fnv1a64:0x1'] };
    const b: LayerPayload = { layerId: 'blake3:testlayer', childHashes: ['fnv1a64:0x1', 'sha256:two', 'sha256:one'] };
    expect(await computeNodeHash('layer', a)).toBe(await computeNodeHash('layer', b));
  });

  it('detects a removed child', async () => {
    const a: LayerPayload = { layerId: 'blake3:testlayer', childHashes: ['sha256:one', 'sha256:two'] };
    const b: LayerPayload = { layerId: 'blake3:testlayer', childHashes: ['sha256:one'] };
    expect(await computeNodeHash('layer', a)).not.toBe(await computeNodeHash('layer', b));
  });
});

describe('computeNodeHash: element', () => {
  it('is order-independent over components, sensitive to a changed child hash', async () => {
    const el: ElementPayload = {
      key: '0GlobalId000000000001',
      ifcType: 'IfcWall',
      components: [
        { componentKey: 'geometry-mesh', hash: 'fnv1a64:0xabc' },
        { componentKey: 'pset:Pset_WallCommon', hash: 'sha256:def' },
      ],
    };
    const reordered: ElementPayload = { ...el, components: [...el.components].reverse() };
    expect(await computeNodeHash('element', el)).toBe(await computeNodeHash('element', reordered));

    const tampered: ElementPayload = {
      ...el,
      components: el.components.map((c) =>
        c.componentKey === 'geometry-mesh' ? { ...c, hash: 'fnv1a64:0xdead' } : c,
      ),
    };
    expect(await computeNodeHash('element', tampered)).not.toBe(await computeNodeHash('element', el));
  });
});

describe('hashResolvedNode', () => {
  it('dispatches to computeNodeHash by discriminant', async () => {
    const direct = await computeNodeHash('geometry-mesh', cubeMesh);
    const viaResolved = await hashResolvedNode({ kind: 'geometry-mesh', payload: cubeMesh });
    expect(viaResolved).toBe(direct);
  });
});
