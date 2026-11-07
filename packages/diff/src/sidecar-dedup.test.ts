/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as identityOracle from '../test/oracle/identity-sidecar.js';
import * as lineageOracle from '../test/oracle/lineage-sidecar.js';
import type { IdentityMapSidecarInit } from './identity-sidecar.js';
import type { LineageSidecarInit } from './lineage-sidecar.js';

type Vector = {
  name: string;
  order?: number[];
  error?: string;
} & ({ kind: 'identity'; init: IdentityMapSidecarInit } | { kind: 'lineage'; init: LineageSidecarInit });

// Exact accepted #8130/#8088 native corpus. Missing corpus is an integration
// error, never an optional prerequisite. Do not regenerate historical vectors.
const vectors: Vector[] = JSON.parse(readFileSync(
  new URL('../../../rust/diff/tests/sidecar_dedup_vectors.json', import.meta.url), 'utf8',
));
const binary = new URL('../../wasm/pkg-diff/ifc-lite-diff_bg.wasm', import.meta.url);
const glue = new URL('../../wasm/pkg-diff/ifc-lite-diff.js', import.meta.url);
const builtEntry = new URL('../dist/index.js', import.meta.url);

// Retain every assertion from accepted main sidecar-dedup.test.ts. Its former
// imports now name declaration-only modules; this independent TS path replaces
// those imports, while the public path below exercises the real WASM facade.
describe('independent TS sidecar deduplication #8088', () => {
  for (const vector of vectors) {
    it(vector.name, () => {
      const create = () => vector.kind === 'identity'
        ? identityOracle.createIdentityMapSidecar(vector.init)
        : lineageOracle.createLineageSidecar(vector.init);
      if (vector.error) {
        expect(create).toThrow(vector.error);
      } else {
        expect(create().entries).toEqual(vector.order?.map((index) => vector.init.entries[index]));
      }
    });
  }
});

for (const entry of ['source', 'built'] as const) {
  describe(`initialized ${entry} public WASM sidecar deduplication #8042 #8088 #8130`, () => {
    for (const vector of vectors) {
      it(vector.name, async (context) => {
        if (!existsSync(binary) || !existsSync(glue)) {
          context.skip('Optional diff WASM glue/binary missing; run pnpm build:wasm, then root pnpm test --filter=@ifc-lite/diff');
          return;
        }
        if (entry === 'built' && !existsSync(builtEntry)) {
          context.skip('Optional built public artifact missing; run root pnpm build, then root pnpm test --filter=@ifc-lite/diff');
          return;
        }
        const api: typeof import('./index.js') = entry === 'source'
          ? await import('./index.js') : await import(builtEntry.href);
        api.initDiffSync({ module: readFileSync(binary) });
        // Fresh input: a public implementation cannot mutate its own TS oracle.
        const input = structuredClone(vector);
        const create = () => input.kind === 'identity'
          ? api.createIdentityMapSidecar(input.init)
          : api.createLineageSidecar(input.init);
        if (vector.error) {
          expect(create).toThrow(vector.error);
        } else {
          const actual = create();
          expect(actual.entries).toEqual(vector.order?.map((index) => vector.init.entries[index]));
          if (vector.kind === 'identity' && input.kind === 'identity') {
            const expected = identityOracle.createIdentityMapSidecar(vector.init);
            const sidecar = api.createIdentityMapSidecar(input.init);
            expect(actual).toEqual(expected);
            const wire = api.serializeIdentityMapSidecar(sidecar);
            expect(wire).toBe(identityOracle.serializeIdentityMapSidecar(expected));
            expect(wire.endsWith('\n')).toBe(true);
            expect(api.parseIdentityMapSidecar(wire)).toEqual(expected);
          } else if (vector.kind === 'lineage' && input.kind === 'lineage') {
            const expected = lineageOracle.createLineageSidecar(vector.init);
            const sidecar = api.createLineageSidecar(input.init);
            expect(actual).toEqual(expected);
            const wire = api.serializeLineageSidecar(sidecar);
            expect(wire).toBe(lineageOracle.serializeLineageSidecar(expected));
            expect(wire.endsWith('\n')).toBe(true);
            expect(api.parseLineageSidecar(wire)).toEqual(expected);
          }
        }
      });
    }
  });
}
