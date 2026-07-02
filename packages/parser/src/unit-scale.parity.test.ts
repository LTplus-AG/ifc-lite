/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { extractLengthUnitScale } from './unit-extractor.js';
import type { EntityIndex, EntityRef } from './types.js';

// The Rust extractor (rust/core/src/units.rs) and this TS extractor are pinned
// to ONE shared vector file so the two cannot drift. The fixture lives in the
// core crate; skip gracefully if this package is tested outside the monorepo.
const fixturePath = fileURLToPath(
  new URL('../../../rust/core/tests/fixtures/unit_scale_vectors.json', import.meta.url),
);

interface Vector {
  name: string;
  /** Minimal but complete ISO-10303-21 file containing the unit chain. */
  ifc: string;
  /** Multiplier that converts file length units to metres. */
  lengthUnitScale: number;
}

/** Build source bytes + EntityIndex over a complete IFC STEP file string. */
function indexIfc(content: string): { source: Uint8Array; entityIndex: EntityIndex } {
  const source = new TextEncoder().encode(content);
  const byId = new Map<number, EntityRef>();
  const byType = new Map<string, number[]>();
  const re = /^#(\d+)=([A-Z0-9_]+)\(/;
  let offset = 0;
  let lineNumber = 0;
  for (const line of content.split('\n')) {
    lineNumber += 1;
    const m = re.exec(line);
    if (m) {
      const expressId = Number(m[1]);
      const type = m[2];
      const ref: EntityRef = {
        expressId,
        type,
        byteOffset: offset,
        byteLength: line.length,
        lineNumber,
      };
      byId.set(expressId, ref);
      const list = byType.get(type) ?? [];
      list.push(expressId);
      byType.set(type, list);
    }
    offset += line.length + 1; // +1 for '\n' (fixtures are pure ASCII)
  }
  return { source, entityIndex: { byId, byType } };
}

describe.skipIf(!existsSync(fixturePath))('extractLengthUnitScale shared parity vectors', () => {
  // Guarded read: with skipIf active (fixture absent outside the monorepo)
  // the describe body still executes at collection time, so an unguarded
  // readFileSync would hard-fail instead of skipping.
  const cases = existsSync(fixturePath)
    ? (JSON.parse(readFileSync(fixturePath, 'utf8')) as { cases: Vector[] }).cases
    : [];

  it('fixture has cases', () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  for (const c of cases) {
    it(`matches the Rust extractor: ${c.name}`, () => {
      const { source, entityIndex } = indexIfc(c.ifc);
      expect(extractLengthUnitScale(source, entityIndex)).toBeCloseTo(c.lengthUnitScale, 12);
    });
  }
});
