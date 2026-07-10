/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { extractProjectUnits, measureUnit } from './project-units.js';
import type { EntityIndex, EntityRef } from './types.js';

// The Rust resolver (rust/core/src/project_units) and this TS resolver are
// pinned to ONE shared vector file so the two cannot drift (issue #1573). The
// fixture lives in the core crate; skip gracefully outside the monorepo.
const fixturePath = fileURLToPath(
  new URL('../../../rust/core/tests/fixtures/unit_symbol_vectors.json', import.meta.url),
);

interface MeasureExpect {
  measure: string;
  symbol: string | null;
  siScale: number | null;
}
interface Vector {
  name: string;
  ifc: string;
  measures: MeasureExpect[];
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
      byId.set(expressId, { expressId, type, byteOffset: offset, byteLength: line.length, lineNumber });
      const list = byType.get(type) ?? [];
      list.push(expressId);
      byType.set(type, list);
    }
    offset += line.length + 1; // +1 for '\n' (fixtures are pure ASCII)
  }
  return { source, entityIndex: { byId, byType } };
}

describe.skipIf(!existsSync(fixturePath))('extractProjectUnits shared parity vectors', () => {
  const cases = existsSync(fixturePath)
    ? (JSON.parse(readFileSync(fixturePath, 'utf8')) as { cases: Vector[] }).cases
    : [];

  it('fixture has cases', () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  for (const c of cases) {
    it(`matches the Rust resolver: ${c.name}`, () => {
      const { source, entityIndex } = indexIfc(c.ifc);
      const units = extractProjectUnits(source, entityIndex);
      for (const m of c.measures) {
        const got = units.unitForMeasure(m.measure);
        if (m.symbol === null) {
          expect(got, `${c.name} / ${m.measure} expected no unit`).toBeNull();
        } else {
          expect(got, `${c.name} / ${m.measure} expected ${m.symbol}`).not.toBeNull();
          expect(got!.symbol, `${c.name} / ${m.measure} symbol`).toBe(m.symbol);
          expect(got!.siScale, `${c.name} / ${m.measure} siScale`).toBeCloseTo(m.siScale!, 12);
        }
      }
    });
  }
});

describe('measureUnit table', () => {
  it('maps the issue #1573 flow rate to its derived unit type', () => {
    expect(measureUnit('IfcVolumetricFlowRateMeasure')).toEqual({
      kind: 'typed',
      unitType: 'VOLUMETRICFLOWRATEUNIT',
      defaultSymbol: 'm³/s',
    });
  });

  it('accepts bare or prefixed names case-insensitively', () => {
    expect(measureUnit('AREAMEASURE')).toEqual(measureUnit('IfcAreaMeasure'));
  });

  it('classifies ratios/counts as dimensionless and non-measures as undefined', () => {
    expect(measureUnit('IfcRatioMeasure')).toEqual({ kind: 'dimensionless' });
    expect(measureUnit('IfcCountMeasure')).toEqual({ kind: 'dimensionless' });
    expect(measureUnit('IfcLabel')).toBeUndefined();
    expect(measureUnit('IfcBoolean')).toBeUndefined();
  });

  it('flags monetary measures', () => {
    expect(measureUnit('IfcMonetaryMeasure')).toEqual({ kind: 'monetary' });
  });
});
