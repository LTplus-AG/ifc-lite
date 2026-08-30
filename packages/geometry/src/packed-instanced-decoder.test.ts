/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import {
  decodeInstancedShard,
  isInstancedShard,
  INSTANCED_SHARD_MAGIC,
  INSTANCED_SHARD_VERSION,
} from './packed-instanced-decoder.js';

// Cross-language conformance fixtures: bytes produced by the Rust encoder via
// the `dump_instanced_fixture` test in instancing.rs.
//
// Both fixtures encode the SAME case, so the only difference between them is the
// version: CANON tetra at three pure translations — m0=(1,0,0) rep50, m1=(0,2,0)
// rep50, m2=(5,5,5) rep60. collate(min_group=2) → 1 shared template (m0 geometry,
// occurrences m0+m1) + 1 singleton template (m2). entityId = 1000+meshIndex;
// colour = [meshIndex*0.1, 0.2, 0.3, 1]; v2 adds itemId = 500+meshIndex.

// FROZEN. A real v1 shard, produced by the encoder before #2985 added the item
// id. NEVER regenerate it: its whole value is that no current code produced it —
// it is the shape already sitting in caches, which store IFNS bytes verbatim and
// still decode. The cache key moves 15 -> 16 with this change, but shard bytes
// also travel by other routes, so a v1 shard must keep decoding regardless.
// Regenerating it would silently turn the backward-compatibility test into a
// second forward-compatibility test. Rust holds the identical bytes as
// `FIXTURE_V1_HEX` in instancing/tests.rs, so both decoders answer for one
// artefact rather than for each other's idea of v1.
const FIXTURE_V1_HEX =
  '534e464901000000020000000300000018000000180000000800000000000000000000000c000000000000000c00000000000000040000000000000000000000000000000000000000000000000000000c0000000c0000000c0000000c000000040000000400000000000000000000000000000000000000000000000000000000000000e803000000000000cdcc4c3e9a99993e0000803f0000803f000000000000000000000000000000000000803f000000000000000000000000000000000000803f000000000000000000000000000000000000803f00000000e9030000cdcccc3dcdcc4c3e9a99993e0000803f0000803f0000000000000000000080bf000000000000803f000000000000004000000000000000000000803f000000000000000000000000000000000000803f01000000ea030000cdcc4c3ecdcc4c3e9a99993e0000803f0000803f000000000000000000000000000000000000803f000000000000000000000000000000000000803f000000000000000000000000000000000000803f0000803f00000000000000000000004000000000000000000000803f0000803f000000000000803f000000000000803f0000a0400000a0400000a0400000c0400000a0400000a0400000a0400000c0400000a0400000a0400000a0400000c0400000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001000000020000000300000000000000010000000200000003000000';

// Current version. Regenerate with:
//   cargo test -p ifc-lite-geometry --lib dump_instanced_fixture -- --ignored --nocapture
// Diff against v1 when you do: version 1→2, header word 7 (reserved→instance
// stride) 0→92, and 4 appended bytes per instance record. Nothing else may move.
const FIXTURE_V2_HEX =
  '534e46490200000002000000030000001800000018000000080000005c000000000000000c000000000000000c00000000000000040000000000000000000000000000000000000000000000000000000c0000000c0000000c0000000c000000040000000400000000000000000000000000000000000000000000000000000000000000e803000000000000cdcc4c3e9a99993e0000803f0000803f000000000000000000000000000000000000803f000000000000000000000000000000000000803f000000000000000000000000000000000000803ff401000000000000e9030000cdcccc3dcdcc4c3e9a99993e0000803f0000803f0000000000000000000080bf000000000000803f000000000000004000000000000000000000803f000000000000000000000000000000000000803ff501000001000000ea030000cdcc4c3ecdcc4c3e9a99993e0000803f0000803f000000000000000000000000000000000000803f000000000000000000000000000000000000803f000000000000000000000000000000000000803ff60100000000803f00000000000000000000004000000000000000000000803f0000803f000000000000803f000000000000803f0000a0400000a0400000a0400000c0400000a0400000a0400000a0400000c0400000a0400000a0400000a0400000c0400000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001000000020000000300000000000000010000000200000003000000';

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

// Apply a row-major mat4 to a point (w assumed 1, affine).
function applyRowMajor(m: Float32Array, x: number, y: number, z: number): [number, number, number] {
  return [
    m[0] * x + m[1] * y + m[2] * z + m[3],
    m[4] * x + m[5] * y + m[6] * z + m[7],
    m[8] * x + m[9] * y + m[10] * z + m[11],
  ];
}

const CANON = [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1];

describe('decodeInstancedShard (Rust↔TS conformance)', () => {
  const bytes = hexToBytes(FIXTURE_V2_HEX);

  it('recognises the instanced magic', () => {
    expect(INSTANCED_SHARD_MAGIC).toBe(0x4946_4e53);
    expect(isInstancedShard(bytes)).toBe(true);
    expect(isInstancedShard(new Uint8Array([1, 2, 3, 4]))).toBe(false);
  });

  it('decodes the template + instance tables produced by the Rust encoder', () => {
    const shard = decodeInstancedShard(bytes);
    // rep50 → 1 shared template (2 occ); rep60 singleton → 1 template (1 occ).
    expect(shard.templates).toHaveLength(2);
    expect(shard.instances).toHaveLength(3);

    // Template 0 is mesh 0's geometry: CANON translated by (1,0,0).
    const expected0 = CANON.map((v, i) => (i % 3 === 0 ? v + 1 : v));
    expect(Array.from(shard.templates[0].positions)).toEqual(expected0);
    // The fixture's mesh helper uses sequential indices over its 4 verts.
    expect(Array.from(shard.templates[0].indices)).toEqual([0, 1, 2, 3]);
    expect(shard.templates[0].origin).toEqual([0, 0, 0]);

    // Instances: m0 (id 1000, template 0), m1 (id 1001, template 0), m2 (id 1002, template 1).
    expect(shard.instances.map((i) => i.entityId)).toEqual([1000, 1001, 1002]);
    expect(shard.instances.map((i) => i.templateIndex)).toEqual([0, 0, 1]);
    // colour = [meshIndex*0.1, 0.2, 0.3, 1]
    expect(shard.instances[1].color[0]).toBeCloseTo(0.1, 5);
    expect(shard.instances[1].color[1]).toBeCloseTo(0.2, 5);
    expect(shard.instances[2].color[0]).toBeCloseTo(0.2, 5);
    // #2985: itemId = 500 + meshIndex, read at the WIDENED v2 stride. At 88 the
    // second record would start inside the first one's transform, so the entity
    // ids above would already be garbage — the two assertions bracket the stride.
    expect(shard.instances.map((i) => i.itemId)).toEqual([500, 501, 502]);
  });

  it('expand-to-flat: applying an instance transform to its template reproduces the occurrence', () => {
    const shard = decodeInstancedShard(bytes);
    // Instance 1 is mesh 1 (translation (0,2,0)); its rel transform applied to
    // template 0 (mesh 0's geometry) must reproduce CANON translated by (0,2,0).
    const inst = shard.instances[1];
    const tmpl = shard.templates[inst.templateIndex];
    const expectedM1 = CANON.map((v, i) => (i % 3 === 1 ? v + 2 : v));
    const n = tmpl.positions.length / 3;
    for (let v = 0; v < n; v += 1) {
      const [wx, wy, wz] = applyRowMajor(
        inst.transform,
        tmpl.origin[0] + tmpl.positions[v * 3],
        tmpl.origin[1] + tmpl.positions[v * 3 + 1],
        tmpl.origin[2] + tmpl.positions[v * 3 + 2]
      );
      expect(wx).toBeCloseTo(expectedM1[v * 3], 4);
      expect(wy).toBeCloseTo(expectedM1[v * 3 + 1], 4);
      expect(wz).toBeCloseTo(expectedM1[v * 3 + 2], 4);
    }
  });

  it('rejects a truncated buffer', () => {
    expect(() => decodeInstancedShard(bytes.slice(0, 40))).toThrow(/truncated/);
  });
});

// ── v1 → v2 compatibility (#2985) ──
//
// The cache FORMAT_VERSION does move, 15 -> 16, so no v16 key serves a v15
// entry. The frozen v1 fixture still has to decode regardless: the
// InstancedShards section stores shard bytes VERBATIM, and those bytes reach
// this decoder by routes the cache key does not gate. That is a claim about bytes, so it is tested against
// bytes: the frozen v1 fixture, decoded by the current decoder.
describe('decodeInstancedShard (v1 backward compatibility)', () => {
  const v1 = hexToBytes(FIXTURE_V1_HEX);

  it('the frozen fixture really is v1', () => {
    // Without this the suite below would silently become a second v2 test the
    // day someone regenerates the constant.
    expect(new Uint32Array(v1.buffer.slice(0, 32))[1]).toBe(1);
  });

  it('decodes a v1 shard whole, at the v1 instance stride', () => {
    const shard = decodeInstancedShard(v1);
    expect(shard.templates).toHaveLength(2);
    expect(shard.instances).toHaveLength(3);
    // Read at 92 instead of 88 these would be garbage read out of the previous
    // record's transform, so they are the stride assertion as much as an id one.
    expect(shard.instances.map((i) => i.entityId)).toEqual([1000, 1001, 1002]);
    expect(shard.instances.map((i) => i.templateIndex)).toEqual([0, 0, 1]);
    expect(Array.from(shard.instances[0].transform)).toEqual(
      Array.from(decodeInstancedShard(hexToBytes(FIXTURE_V2_HEX)).instances[0].transform)
    );
  });

  it('reports no itemId on a v1 shard rather than fabricating one', () => {
    const shard = decodeInstancedShard(v1);
    // The KEY is always present — the decoder gives every DecodedInstance one
    // object shape rather than a conditional spread — so what is asserted is the
    // VALUE: undefined, never a fabricated `#0` a host would follow to nothing.
    expect(shard.instances.map((i) => i.itemId)).toEqual([undefined, undefined, undefined]);
    expect(shard.carriesItemIds).toBe(false);
  });

  it('refuses version 0, which is not a version', () => {
    const bad = v1.slice();
    new DataView(bad.buffer).setUint32(4, 0, true);
    expect(() => decodeInstancedShard(bad)).toThrow(/Unsupported instanced shard version/);
  });

  it('reports carriesItemIds false, so a consumer allocates no id column', () => {
    expect(decodeInstancedShard(v1).carriesItemIds).toBe(false);
    expect(decodeInstancedShard(hexToBytes(FIXTURE_V2_HEX)).carriesItemIds).toBe(true);
  });
});

// ── Synthetic shards ──
//
// The Rust fixture above is a valid, well-formed shard whose template origins
// are all (0,0,0). A zero origin makes the three f64 reads indistinguishable
// from one another (swap X and Y and the suite stays green), and a valid shard
// never exercises the two bounds guards. These build shards from the LAYOUT
// documented on the decoder, so both statements of the format are independent.

const HEADER_WORDS = 8;
const TEMPLATE_RECORD_BYTES = 48;
/** Instance record bytes before the flag-gated trailing itemId. */
const INSTANCE_RECORD_BASE_BYTES = 88;

interface SynthTemplate {
  posOff: number;
  posLen: number;
  nrmOff: number;
  nrmLen: number;
  idxOff: number;
  idxLen: number;
  origin: [number, number, number];
}

interface SynthInstance {
  templateIndex: number;
  entityId: number;
  color: [number, number, number, number];
  transform: number[];
  /** Written only when the declared stride makes room for it. */
  itemId?: number;
  /** Bytes of a trailing field appended by a producer NEWER than this build,
   *  written after every field it knows. Only meaningful when `stride` leaves
   *  room for them. */
  unknownTail?: number[];
}

/** Builds a shard from the LAYOUT documented on the decoder, at whichever
 *  version/stride it is told, so this file's statement of the format stays
 *  independent of the decoder's. */
function encodeInstancedShard(opts: {
  templates: SynthTemplate[];
  instances: SynthInstance[];
  positions: number[];
  normals: number[];
  indices: number[];
  version?: number;
  /** Header word 7. Defaults to the stride this build's encoder would write:
   *  the 88-byte base for v1, base + itemId for v2 and up. */
  stride?: number;
}): Uint8Array {
  const { templates, instances, positions, normals, indices } = opts;
  const version = opts.version ?? INSTANCED_SHARD_VERSION;
  const declaredStride =
    opts.stride ?? (version >= 2 ? INSTANCE_RECORD_BASE_BYTES + 4 : 0);
  const instanceStride =
    declaredStride === 0 ? INSTANCE_RECORD_BASE_BYTES : declaredStride;
  const carriesItemId = instanceStride >= INSTANCE_RECORD_BASE_BYTES + 4;
  const templateTableOffset = HEADER_WORDS * 4;
  const instanceTableOffset = templateTableOffset + templates.length * TEMPLATE_RECORD_BYTES;
  const dataOffset = instanceTableOffset + instances.length * instanceStride;
  const total = dataOffset + (positions.length + normals.length + indices.length) * 4;
  const buf = new ArrayBuffer(total);
  const view = new DataView(buf);

  [
    INSTANCED_SHARD_MAGIC,
    version,
    templates.length,
    instances.length,
    positions.length,
    normals.length,
    indices.length,
    declaredStride,
  ].forEach((w, i) => view.setUint32(i * 4, w, true));

  templates.forEach((t, i) => {
    const base = templateTableOffset + i * TEMPLATE_RECORD_BYTES;
    [t.posOff, t.posLen, t.nrmOff, t.nrmLen, t.idxOff, t.idxLen].forEach((w, k) =>
      view.setUint32(base + k * 4, w, true)
    );
    t.origin.forEach((v, k) => view.setFloat64(base + 24 + k * 8, v, true));
  });

  instances.forEach((inst, i) => {
    const base = instanceTableOffset + i * instanceStride;
    view.setUint32(base, inst.templateIndex, true);
    view.setUint32(base + 4, inst.entityId, true);
    inst.color.forEach((c, k) => view.setFloat32(base + 8 + k * 4, c, true));
    inst.transform.forEach((m, k) => view.setFloat32(base + 24 + k * 4, m, true));
    if (carriesItemId) {
      view.setUint32(base + INSTANCE_RECORD_BASE_BYTES, inst.itemId ?? 0, true);
    }
    (inst.unknownTail ?? []).forEach((b, k) => {
      view.setUint8(base + INSTANCE_RECORD_BASE_BYTES + 4 + k, b);
    });
  });

  let cursor = dataOffset;
  positions.forEach((v) => {
    view.setFloat32(cursor, v, true);
    cursor += 4;
  });
  normals.forEach((v) => {
    view.setFloat32(cursor, v, true);
    cursor += 4;
  });
  indices.forEach((v) => {
    view.setUint32(cursor, v, true);
    cursor += 4;
  });

  return new Uint8Array(buf);
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function synthShard(over: Partial<Parameters<typeof encodeInstancedShard>[0]> = {}) {
  return encodeInstancedShard({
    templates: [
      { posOff: 0, posLen: 3, nrmOff: 0, nrmLen: 3, idxOff: 0, idxLen: 1, origin: [0, 0, 0] },
    ],
    instances: [
      { templateIndex: 0, entityId: 1, color: [1, 1, 1, 1], transform: IDENTITY },
    ],
    positions: [0, 0, 0],
    normals: [0, 0, 1],
    indices: [0],
    ...over,
  });
}

describe('decodeInstancedShard (synthetic edge cases)', () => {
  it('decodes a non-zero template origin axis-by-axis', () => {
    const shard = decodeInstancedShard(
      synthShard({
        templates: [
          {
            posOff: 0,
            posLen: 3,
            nrmOff: 0,
            nrmLen: 3,
            idxOff: 0,
            idxLen: 1,
            // Three distinct values: swapping any pair of the f64 reads shows up.
            origin: [12345.5, -6789.25, 42.125],
          },
        ],
      })
    );

    expect(shard.templates[0].origin).toEqual([12345.5, -6789.25, 42.125]);
  });

  it('rejects a template whose pool range runs past the positions pool', () => {
    expect(() =>
      decodeInstancedShard(
        synthShard({
          templates: [
            { posOff: 2, posLen: 3, nrmOff: 0, nrmLen: 3, idxOff: 0, idxLen: 1, origin: [0, 0, 0] },
          ],
        })
      )
    ).toThrow(/template 0 pool offset out of bounds/);
  });

  it('rejects a template whose normals range runs past the normals pool', () => {
    expect(() =>
      decodeInstancedShard(
        synthShard({
          templates: [
            { posOff: 0, posLen: 3, nrmOff: 1, nrmLen: 3, idxOff: 0, idxLen: 1, origin: [0, 0, 0] },
          ],
        })
      )
    ).toThrow(/template 0 pool offset out of bounds/);
  });

  it('rejects a template whose index range runs past the indices pool', () => {
    expect(() =>
      decodeInstancedShard(
        synthShard({
          templates: [
            { posOff: 0, posLen: 3, nrmOff: 0, nrmLen: 3, idxOff: 0, idxLen: 2, origin: [0, 0, 0] },
          ],
        })
      )
    ).toThrow(/template 0 pool offset out of bounds/);
  });

  it('rejects an instance that references a template the shard does not carry', () => {
    expect(() =>
      decodeInstancedShard(
        synthShard({
          instances: [
            { templateIndex: 0, entityId: 1, color: [1, 1, 1, 1], transform: IDENTITY },
            { templateIndex: 3, entityId: 2, color: [1, 1, 1, 1], transform: IDENTITY },
          ],
        })
      )
    ).toThrow(/instance 1 references missing template 3 \(have 1\)/);
  });

  it('accepts a template that exactly fills each pool', () => {
    const shard = decodeInstancedShard(synthShard());

    expect(shard.templates[0].positions).toHaveLength(3);
    expect(shard.instances).toHaveLength(1);
  });

  it('reads a v1-strided instance table when the stride word is 0', () => {
    // The stride must follow the STRIDE WORD, not the decoder's own current
    // version. A v1-shaped body (88-byte records, no itemId) built here and read
    // back proves that, independently of the frozen Rust fixture.
    const shard = decodeInstancedShard(
      synthShard({
        version: 1,
        instances: [
          { templateIndex: 0, entityId: 7, color: [1, 1, 1, 1], transform: IDENTITY },
          { templateIndex: 0, entityId: 9, color: [1, 1, 1, 1], transform: IDENTITY },
        ],
      })
    );

    expect(shard.instances.map((i) => i.entityId)).toEqual([7, 9]);
    expect(shard.instances.map((i) => i.itemId)).toEqual([undefined, undefined]);
  });

  it('carries an itemId per occurrence, and reads 0 as absent', () => {
    // 0 is the producer's "no item" sentinel (STEP names start at #1). Returning
    // it verbatim would hand a host a #0 to follow to nothing — the #3199 defect
    // one field over.
    const shard = decodeInstancedShard(
      synthShard({
        instances: [
          { templateIndex: 0, entityId: 7, color: [1, 1, 1, 1], transform: IDENTITY, itemId: 11 },
          { templateIndex: 0, entityId: 9, color: [1, 1, 1, 1], transform: IDENTITY, itemId: 0 },
        ],
      })
    );

    expect(shard.instances.map((i) => i.itemId)).toEqual([11, undefined]);
    // The widened stride must not disturb the fields ahead of it.
    expect(shard.instances.map((i) => i.entityId)).toEqual([7, 9]);
  });

  it('reads a shard from a FUTURE version that appended a trailing field', () => {
    // Forward compatibility, the whole point of spending header word 7 on a
    // stride rather than on flags. A v3 producer appends trailing field 2; this
    // build knows only field 1, finds every field it knows at its fixed offset,
    // and steps over the tail it does not. Under the flags word this replaced,
    // the same shard was refused outright — an unknown flag bit changes the
    // stride unknowably, so flags could only ever gate, never carry.
    const shard = decodeInstancedShard(
      synthShard({
        version: 3,
        stride: 96, // 88 base + itemId(4) + 4 bytes this build has never heard of
        instances: [
          {
            templateIndex: 0,
            entityId: 7,
            color: [0.25, 0.5, 0.75, 1],
            transform: IDENTITY,
            itemId: 11,
            unknownTail: [0xde, 0xad, 0xbe, 0xef],
          },
          {
            templateIndex: 0,
            entityId: 9,
            color: [1, 1, 1, 1],
            transform: IDENTITY,
            itemId: 15,
            unknownTail: [0xde, 0xad, 0xbe, 0xef],
          },
        ],
      })
    );

    expect(shard.carriesItemIds).toBe(true);
    expect(shard.instances.map((i) => i.entityId)).toEqual([7, 9]);
    expect(shard.instances.map((i) => i.itemId)).toEqual([11, 15]);
    expect(shard.instances[0].color[0]).toBeCloseTo(0.25, 5);
    expect(Array.from(shard.instances[0].transform)).toEqual(IDENTITY);
    // Read at 92 instead of the declared 96, record 1 would start inside record
    // 0's unknown tail and every field above would be garbage.
    expect(shard.templates[0].positions).toHaveLength(3);
  });

  it('refuses a stride below the 88-byte base record', () => {
    // The base fields are not optional: reading at a shorter stride slices each
    // record out of its predecessor's transform and yields plausible garbage.
    expect(() => decodeInstancedShard(synthShard({ version: 2, stride: 87 }))).toThrow(
      /stride 87 is below the 88-byte base record/
    );
  });

  it('refuses an unaligned stride instead of throwing a RangeError', () => {
    // The two decoders have to refuse the same shards. This one CANNOT read an
    // unaligned stride: templateCount 1 + instanceCount 1 at stride 90 puts the
    // data offset at 32 + 48 + 90 = 170, and `new Float32Array(buffer, 170, n)`
    // throws "start offset ... should be a multiple of 4" — an opaque RangeError
    // where the stride gate exists to raise a format error. Rust reads the same
    // bytes through byte slices and used to accept them, so on exactly the
    // shards the permissive-version rule promises to read, the two statements of
    // the format disagreed.
    for (const stride of [89, 90, 91, 94]) {
      expect(() => decodeInstancedShard(synthShard({ version: 2, stride }))).toThrow(
        new RegExp(`stride ${stride} is not a multiple of 4`)
      );
    }
  });

  it('refuses a stride whose instance table cannot fit the buffer', () => {
    const bytes = synthShard();
    // 4-ALIGNED on purpose: an unaligned value would be refused one guard
    // earlier and this would stop exercising the buffer-fit check at all.
    new DataView(bytes.buffer).setUint32(28, 0xffff_fffc, true);
    expect(() => decodeInstancedShard(bytes)).toThrow(/truncated/);
  });

  it('reads the transform in the stored row order', () => {
    // Asymmetric matrix: a transposed read yields a different array.
    const m = Array.from({ length: 16 }, (_, i) => i + 1);
    const shard = decodeInstancedShard(
      synthShard({
        instances: [{ templateIndex: 0, entityId: 1, color: [1, 1, 1, 1], transform: m }],
      })
    );

    expect(Array.from(shard.instances[0].transform)).toEqual(m);
  });
});
