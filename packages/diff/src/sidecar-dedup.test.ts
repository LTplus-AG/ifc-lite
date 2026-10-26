/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createIdentityMapSidecar, type IdentityMapSidecarInit } from './identity-sidecar.js';
import { createLineageSidecar, type LineageSidecarInit } from './lineage-sidecar.js';

type Vector = {
  name: string;
  order?: number[];
  error?: string;
} & ({ kind: 'identity'; init: IdentityMapSidecarInit } | { kind: 'lineage'; init: LineageSidecarInit });

// The Rust document tests consume the same behavioral corpus (#8088).
const vectors: Vector[] = JSON.parse(readFileSync(
  new URL('../../../rust/diff/tests/sidecar_dedup_vectors.json', import.meta.url), 'utf8',
));
describe('sidecar deduplication #8088', () => {
  for (const vector of vectors) {
    it(vector.name, () => {
      const create = () => vector.kind === 'identity'
        ? createIdentityMapSidecar(vector.init)
        : createLineageSidecar(vector.init);
      if (vector.error) {
        expect(create).toThrow(vector.error);
      } else {
        expect(create().entries).toEqual(vector.order?.map((index) => vector.init.entries[index]));
      }
    });
  }
});
