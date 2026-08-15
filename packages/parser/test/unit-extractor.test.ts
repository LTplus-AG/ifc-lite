/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Tests for the length-unit-scale extractor.
 *
 * The TS extractor is a wasm-free mirror of the canonical Rust implementation
 * (rust/core/src/units.rs) that drives geometry scaling on the server and the
 * wasm path. These cases pin TS↔Rust parity for the unit-resolution chain —
 * in particular the IfcMeasureWithUnit edge case where an unreadable
 * ValueComponent must default to 1.0 while STILL applying the UnitComponent
 * SI-prefix (a drift here means properties scale differently from meshes).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { extractLengthUnitScale } from '../src/unit-extractor.js';
import type { EntityIndex, EntityRef } from '../src/types.js';

/** Build source bytes + EntityIndex from a synthetic STEP DATA section. */
function harness(dataLines: string[]): { source: Uint8Array; entityIndex: EntityIndex } {
  const content = [
    'ISO-10303-21;',
    'HEADER;',
    "FILE_DESCRIPTION((''),'2;1');",
    "FILE_NAME('t.ifc','2024-01-01T00:00:00',(''),(''),'','','');",
    "FILE_SCHEMA(('IFC4'));",
    'ENDSEC;',
    'DATA;',
    ...dataLines,
    'ENDSEC;',
    'END-ISO-10303-21;',
    '',
  ].join('\n');
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
    offset += line.length + 1; // +1 for '\n'
  }
  return { source, entityIndex: { byId, byType } };
}

const PROJECT = "#1=IFCPROJECT('0001proj',$,'P',$,$,$,$,$,#2);";

describe('extractLengthUnitScale', () => {
  it('returns 1.0 for plain SI metres', () => {
    const { source, entityIndex } = harness([
      PROJECT,
      '#2=IFCUNITASSIGNMENT((#3));',
      '#3=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);',
    ]);
    expect(extractLengthUnitScale(source, entityIndex)).toBe(1.0);
  });

  it('returns 0.001 for MILLI-prefixed SI metres', () => {
    const { source, entityIndex } = harness([
      PROJECT,
      '#2=IFCUNITASSIGNMENT((#3));',
      '#3=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);',
    ]);
    expect(extractLengthUnitScale(source, entityIndex)).toBeCloseTo(0.001, 10);
  });

  it('resolves a known conversion-based unit by name (FOOT)', () => {
    const { source, entityIndex } = harness([
      PROJECT,
      '#2=IFCUNITASSIGNMENT((#3));',
      "#3=IFCCONVERSIONBASEDUNIT(#4,.LENGTHUNIT.,'FOOT',#5);",
      '#4=IFCDIMENSIONALEXPONENTS(1,0,0,0,0,0,0);',
      '#5=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(0.3048),#6);',
      '#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);',
    ]);
    expect(extractLengthUnitScale(source, entityIndex)).toBeCloseTo(0.3048, 10);
  });

  it('resolves an unnamed conversion-based unit from its IfcMeasureWithUnit', () => {
    const { source, entityIndex } = harness([
      PROJECT,
      '#2=IFCUNITASSIGNMENT((#3));',
      "#3=IFCCONVERSIONBASEDUNIT(#4,.LENGTHUNIT.,'CUSTOM_UNIT',#5);",
      '#4=IFCDIMENSIONALEXPONENTS(1,0,0,0,0,0,0);',
      '#5=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(25.4),#6);',
      '#6=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);',
    ]);
    // 25.4 millimetres → 0.0254 m (UnitComponent prefix applies).
    expect(extractLengthUnitScale(source, entityIndex)).toBeCloseTo(0.0254, 10);
  });

  it('defaults an unreadable ValueComponent to 1.0 but still applies the UnitComponent prefix (Rust parity)', () => {
    // rust/core/src/units.rs treats a non-numeric ValueComponent as 1.0 and
    // still resolves the UnitComponent SI-prefix. The TS extractor must do
    // the same — falling through to metres here while the Rust side scales
    // geometry by 0.001 would desync property scaling from mesh scaling.
    const { source, entityIndex } = harness([
      PROJECT,
      '#2=IFCUNITASSIGNMENT((#3));',
      "#3=IFCCONVERSIONBASEDUNIT(#4,.LENGTHUNIT.,'BROKEN_UNIT',#5);",
      '#4=IFCDIMENSIONALEXPONENTS(1,0,0,0,0,0,0);',
      '#5=IFCMEASUREWITHUNIT($,#6);',
      '#6=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);',
    ]);
    expect(extractLengthUnitScale(source, entityIndex)).toBeCloseTo(0.001, 10);
  });

  it('defaults to metres when no length unit exists', () => {
    const { source, entityIndex } = harness([
      PROJECT,
      '#2=IFCUNITASSIGNMENT((#3));',
      '#3=IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.);',
    ]);
    expect(extractLengthUnitScale(source, entityIndex)).toBe(1.0);
  });

  // #2104: extractLengthUnitScale returns 1.0 both for "confirmed metres" and
  // for "I could not determine the scale" — the two are indistinguishable to
  // every caller unless the unknown case leaves a signal. These pin that a
  // genuinely unknown unit now warns, that a genuinely confirmed metres
  // result (no-prefix IFCSIUNIT) does NOT warn, and that the warning is
  // latched per model (entityIndex) rather than flooding on repeat calls for
  // the same store.
  describe('unknown-unit warning (#2104)', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('warns when no length unit is declared at all (genuinely unknown, not confirmed metres)', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { source, entityIndex } = harness([
        PROJECT,
        '#2=IFCUNITASSIGNMENT((#3));',
        '#3=IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.);',
      ]);
      const scale = extractLengthUnitScale(source, entityIndex);
      expect(scale).toBe(1.0);
      expect(warn).toHaveBeenCalled();
      expect(warn.mock.calls.some(([msg]) => String(msg).includes('#2104'))).toBe(true);
    });

    it('warns on a missing IFCPROJECT', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { source, entityIndex } = harness([]);
      expect(extractLengthUnitScale(source, entityIndex)).toBe(1.0);
      expect(warn).toHaveBeenCalled();
    });

    it('warns on an unrecognized SI prefix', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { source, entityIndex } = harness([
        PROJECT,
        '#2=IFCUNITASSIGNMENT((#3));',
        '#3=IFCSIUNIT(*,.LENGTHUNIT.,.BOGUSPREFIX.,.METRE.);',
      ]);
      expect(extractLengthUnitScale(source, entityIndex)).toBe(1.0);
      expect(warn).toHaveBeenCalled();
    });

    it('does NOT warn for a confirmed metres declaration (no-prefix IFCSIUNIT)', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { source, entityIndex } = harness([
        PROJECT,
        '#2=IFCUNITASSIGNMENT((#3));',
        '#3=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);',
      ]);
      expect(extractLengthUnitScale(source, entityIndex)).toBe(1.0);
      expect(warn).not.toHaveBeenCalled();
    });

    it('does NOT warn for a resolvable millimetre unit', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { source, entityIndex } = harness([
        PROJECT,
        '#2=IFCUNITASSIGNMENT((#3));',
        '#3=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);',
      ]);
      expect(extractLengthUnitScale(source, entityIndex)).toBeCloseTo(0.001, 10);
      expect(warn).not.toHaveBeenCalled();
    });

    it('latches: warns once across many calls for the same model, but a fresh model warns again', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { source, entityIndex } = harness([
        PROJECT,
        '#2=IFCUNITASSIGNMENT((#3));',
        '#3=IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.);',
      ]);

      // Same entityIndex object, called repeatedly (mirrors extract-walls.ts
      // calling this once per storey on the same store) — only the first
      // call should warn.
      extractLengthUnitScale(source, entityIndex);
      extractLengthUnitScale(source, entityIndex);
      extractLengthUnitScale(source, entityIndex);
      expect(warn).toHaveBeenCalledTimes(1);

      // A different model (fresh entityIndex object) is a fresh context and
      // must report again — this is a two-valued signal (warned/not-warned
      // per model), not a permanently-tripped module-global latch.
      const fresh = harness([
        PROJECT,
        '#2=IFCUNITASSIGNMENT((#3));',
        '#3=IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.);',
      ]);
      extractLengthUnitScale(fresh.source, fresh.entityIndex);
      expect(warn).toHaveBeenCalledTimes(2);
    });
  });
});
