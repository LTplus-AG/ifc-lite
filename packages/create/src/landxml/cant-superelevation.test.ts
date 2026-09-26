/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Cant and superelevation stay refused (mapping spec §13, #5634), and the
 * refusal says which alignment carries them and why IFC 4.3 cannot take them
 * from this source. Driven through `landXmlToIfc`, the seam the export uses.
 */

import { describe, expect, it } from 'vitest';
import { landXmlToIfc } from './landxml-to-ifc.js';
import type { LandXmlIfcAlignment, LandXmlIfcSource } from './source-types.js';
import type { LandXmlIfcResult, LandXmlRefusal } from './result-types.js';

const UNITS = {
  linearUnit: 'meter', elevationUnit: 'meter', linearScaleToMeters: 1, elevationScaleToMeters: 1, assumed: false,
} as const;

/** A 100 m straight — the simplest alignment the mapping writes. */
function straight(name: string, extra: Partial<LandXmlIfcAlignment> = {}): LandXmlIfcAlignment {
  return {
    sourceId: `landxml:alignment:${name}`, name, staStart: 0,
    segments: [{
      sourceId: `landxml:alignment:${name}:segment:1`, ordinal: 1,
      primitive: {
        kind: 'line',
        start: { kind: 'coordinates', point: { northing: 0, easting: 0 } },
        end: { kind: 'coordinates', point: { northing: 0, easting: 100 } },
        declaredLength: 100,
      },
    }],
    ...extra,
  };
}

/** A shape the mapping refuses whole (§11.2). */
function irregular(name: string, extra: Partial<LandXmlIfcAlignment> = {}): LandXmlIfcAlignment {
  return straight(name, {
    segments: [{
      sourceId: `landxml:alignment:${name}:segment:1`, ordinal: 1,
      primitive: {
        kind: 'irregular_line',
        start: { kind: 'coordinates', point: { northing: 0, easting: 0 } },
        end: { kind: 'coordinates', point: { northing: 1, easting: 1 } },
        declaredLength: null,
      },
    }],
    ...extra,
  });
}

const CANT = { sourceId: 'cant', name: 'Rail', gauge: 1.435, rotationPoint: 'center' };
const cantStations = (n: number) => Array.from({ length: n }, (_, i) => ({ station: i * 10, appliedCant: 150 }));

function convert(alignments: LandXmlIfcAlignment[]): Extract<LandXmlIfcResult, { status: 'exported' }> {
  const source: LandXmlIfcSource = { schema: 'LandXML-1.2', version: '1.2', units: UNITS, surfaces: [], alignments };
  const result = landXmlToIfc(source, { timestampMs: 0 });
  if (result.status !== 'exported') throw new Error(`expected an export, got: ${result.reason}`);
  return result;
}

function refusal(result: { refusals: readonly LandXmlRefusal[] }, family: LandXmlRefusal['family']): LandXmlRefusal {
  const row = result.refusals.find((entry) => entry.family === family);
  if (!row) throw new Error(`no '${family}' refusal in ${JSON.stringify(result.refusals.map((r) => r.family))}`);
  return row;
}

describe('cant is refused, precisely (§13.2)', () => {
  it('names each written alignment that carries cant, with its CantStation count', () => {
    const result = convert([
      straight('Track 1', { cant: CANT, cantStations: cantStations(3) }),
      straight('Track 2', { cant: CANT, cantStations: cantStations(1) }),
      straight('Track 3'),
    ]);
    const row = refusal(result, 'cant');
    expect(row.count).toBe(2);
    expect(row.message).toContain("2 cant records will not be included ('Track 1': 3 CantStations; 'Track 2': 1 CantStation)");
    expect(row.message).not.toContain('Track 3');
  });

  it('gives the IFC 4.3 reason: a cant layout needs a vertical layout and a segmented reference curve', () => {
    const row = refusal(convert([straight('Track 1', { cant: CANT, cantStations: cantStations(2) })]), 'cant');
    expect(row.message).toMatch(/IfcAlignmentCant, which it permits only together with a vertical layout/);
    expect(row.message).toMatch(/IfcSegmentedReferenceCurve/);
    expect(row.message).toMatch(/mapping spec §13/);
  });

  it('names a Cant that holds only SpeedStations, rather than dropping it', () => {
    const row = refusal(convert([straight('Track 1', { cant: CANT, cantStations: [] })]), 'cant');
    expect(row.message).toContain("'Track 1': 0 CantStations");
  });

  it('writes the horizontal layout and no cant entity at all', () => {
    const result = convert([straight('Track 1', { cant: CANT, cantStations: cantStations(2) })]);
    expect(result.coverage.alignments).toBe(1);
    expect(result.content).toContain('IFCALIGNMENTHORIZONTAL(');
    expect(result.content).not.toMatch(/IFCALIGNMENTCANT|IFCSEGMENTEDREFERENCECURVE/);
  });

  it('does not name the cant of an alignment that is itself refused — it is already missing with it', () => {
    const result = convert([
      straight('Track 1', { cant: CANT, cantStations: cantStations(2) }),
      irregular('Siding', { cant: CANT, cantStations: cantStations(4) }),
    ]);
    expect(refusal(result, 'alignments').message).toContain("'Siding'");
    expect(refusal(result, 'cant').message).not.toContain('Siding');
  });
});

describe('superelevation is refused, precisely (§13.4)', () => {
  it('names each alignment with its Superelevation block count and totals the blocks', () => {
    const block = { sourceId: 'se', staStart: 10, staEnd: 90, events: [] };
    const result = convert([
      straight('Road A', { superelevations: [block, block] }),
      straight('Road B', { superelevations: [block] }),
    ]);
    const row = refusal(result, 'superelevation');
    expect(row.count).toBe(3);
    expect(row.message).toContain(
      "3 superelevation records will not be included ('Road A': 2 Superelevation blocks; 'Road B': 1 Superelevation block)",
    );
  });

  it('gives the reason: Pset_Superelevation needs values LandXML does not carry', () => {
    const block = { sourceId: 'se', staStart: 10, staEnd: 90, events: [] };
    const result = convert([straight('Road A', { superelevations: [block] })]);
    const row = refusal(result, 'superelevation');
    expect(row.message).toMatch(/IfcReferent \.SUPERELEVATIONEVENT\. with Pset_Superelevation/);
    expect(row.message).toMatch(/normal-crown slope/);
    expect(result.content).not.toMatch(/SUPERELEVATIONEVENT|Pset_Superelevation/);
  });
});
