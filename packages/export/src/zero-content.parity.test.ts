/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * TypeScript half of the empty-export pin (#7695, EXPORT-GEOM-9/15).
 *
 * The Rust exporters (`rust/export/tests/empty_export_parity.rs`) and the wasm
 * entry points (`scripts/lib/wasm-empty-export-contracts.mjs`) are held to the
 * same vectors. This side pins the TS content counters the CLI and MCP keep
 * as defense-in-depth: each must read what main used to return as success
 * for an empty model as empty, so the TS check and the Rust refusal agree.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { countObjVertices } from './obj.js';
import { countUsdMeshes } from './zero-content.js';

interface Vectors {
  policy: Record<'renderGeometry' | 'data', { formats: string[]; whenNone: string }>;
  cases: Array<{ name: string; expect: Record<string, string> }>;
  legacyEmptyArtifacts: Record<string, string>;
}

// NOT guarded by `existsSync`: a missing fixture means the pin is not being
// enforced, which must fail loudly.
const vectors: Vectors = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../rust/export/tests/fixtures/empty_export_vectors.json', import.meta.url)),
    'utf8',
  ),
);

const bytes = (s: string) => new TextEncoder().encode(s);

/** The TS content counter for each render format that has one. */
const COUNTERS: Record<string, (artifact: Uint8Array) => number> = {
  obj: countObjVertices,
  usd: countUsdMeshes,
};

describe('empty-export vectors (#7695)', () => {
  it('the policy splits render-geometry formats from data formats, with no overlap', () => {
    const render = vectors.policy.renderGeometry.formats;
    const data = vectors.policy.data.formats;
    expect(render).toEqual(expect.arrayContaining(['glb', 'gltf', 'obj', 'usd']));
    expect(data).toEqual(expect.arrayContaining(['csv', 'json', 'jsonld', 'step']));
    expect(render.filter((f) => data.includes(f))).toEqual([]);
    expect(vectors.policy.renderGeometry.whenNone).toBe('NO_RENDER_GEOMETRY');
    expect(vectors.policy.data.whenNone).toBe('ok');
  });

  it('a data format never refuses, and some render format refuses in every empty case', () => {
    for (const c of vectors.cases) {
      for (const [format, want] of Object.entries(c.expect)) {
        if (vectors.policy.data.formats.includes(format)) expect(want, `${c.name}/${format}`).toBe('ok');
      }
    }
    expect(vectors.cases.some((c) => Object.values(c.expect).includes('NO_RENDER_GEOMETRY'))).toBe(true);
  });

  for (const [format, artifact] of Object.entries(vectors.legacyEmptyArtifacts)) {
    if (format === 'about') continue;
    it(`the ${format} counter reads main's former empty ${format} as empty`, () => {
      const count = COUNTERS[format];
      expect(count, `no TS counter for ${format}`).toBeTypeOf('function');
      expect(count(bytes(artifact))).toBe(0);
    });
  }
});

describe('countUsdMeshes', () => {
  it('counts baked meshes and instance occurrences, not prototypes', () => {
    const usda = [
      '#usda 1.0',
      'def Xform "World"',
      '{',
      '    def Scope "Prototypes"',
      '    {',
      '        class Mesh "Proto_7"',
      '        {',
      '        }',
      '    }',
      '    def Xform "IfcWall_1"',
      '    {',
      '        def Mesh "Body" (',
      '        )',
      '        {',
      '        }',
      '        def Mesh "Occurrence_2" (',
      '            prepend references = </World/Prototypes/Proto_7>',
      '        )',
      '        {',
      '        }',
      '    }',
      '}',
      '',
    ].join('\n');
    expect(countUsdMeshes(bytes(usda))).toBe(2);
  });

  it('ignores a `def Mesh` inside a string value', () => {
    expect(countUsdMeshes(bytes('def Xform "World"\n{\n    custom string ifc:name = "def Mesh \\"x\\""\n}\n'))).toBe(0);
  });

  it('returns 0 for non-UTF-8 bytes rather than throwing', () => {
    expect(countUsdMeshes(new Uint8Array([0xff, 0xfe, 0xfd]))).toBe(0);
  });
});
