/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { tableToCsv } from '@ifc-lite/export';
import { createClashEngine } from '../engine.js';
import { groupClashes } from '../grouping.js';
import { clashReviewKey } from '../review.js';
import type { AABB, Clash, ClashElement, ClashElementRef, ClashReview, Vec3 } from '../types.js';
import { CLASH_TABLE_COLUMNS, bareIfcGuid, clashTableRows } from './table.js';

const LF = String.fromCharCode(10);
const GUID_A = '0YvctVUKr0kugbFTf53O9L';
const GUID_B = '2O2Fr$t4X7Zf8NOew3FLKI';

function box(key: string, model: string, tag: string, min: Vec3, max: Vec3, name?: string): ClashElement {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  return {
    key, ref: 0, model, tag, name,
    bounds: { min, max },
    positions: new Float32Array([
      x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0,
      x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1,
    ]),
    indices: new Uint32Array([
      0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1,
      1, 5, 6, 1, 6, 2, 2, 6, 7, 2, 7, 3, 3, 7, 4, 3, 4, 0,
    ]),
  };
}

const BOUNDS: AABB = { min: [0, 0, 0], max: [1, 1, 1] };

function ref(key: string, tag: string, model = 'm', name?: string): ClashElementRef {
  return { key, ref: 1, model, tag, name };
}

function clash(partial: Partial<Clash> & Pick<Clash, 'id' | 'a' | 'b'>): Clash {
  return {
    rule: 'r', status: 'hard', distance: -0.05, point: [1, 2, 3], bounds: BOUNDS, severity: 'major',
    ...partial,
  };
}

describe('bareIfcGuid', () => {
  it('returns a plain IfcGUID key unchanged and strips an instanced-occurrence suffix', () => {
    expect(bareIfcGuid(GUID_A)).toBe(GUID_A);
    expect(bareIfcGuid(`${GUID_A}:occ-7`)).toBe(GUID_A);
  });

  it('is empty for a synthetic expressid key, a USD prim path and a malformed 22-char value, so a reader cannot join on a non-GUID', () => {
    expect(bareIfcGuid('expressid:model.ifc:42')).toBe('');
    expect(bareIfcGuid('/Site/Building/Wall_1')).toBe('');
    expect(bareIfcGuid('')).toBe('');
    // 22 characters of the alphabet but the first encodes more than 2 bits —
    // not a GUID the encoder could have produced (review finding).
    expect(bareIfcGuid('Z000000000000000000000')).toBe('');
    expect(bareIfcGuid('4000000000000000000000')).toBe('');
    expect(bareIfcGuid('3zzzzzzzzzzzzzzzzzzzzz')).toBe('3zzzzzzzzzzzzzzzzzzzzz');
  });
});

describe('clashTableRows', () => {
  it('puts both elements of a real engine clash on one row with bare GUIDs, types, names and the signed distance', async () => {
    const pipe = box(GUID_A, 'mep.ifc', 'IfcPipeSegment', [0, 0, 0], [1, 1, 1], 'Pipe 1');
    const beam = box(`${GUID_B}:occ-1`, 'str.ifc', 'IfcBeam', [0.5, 0, 0], [1.5, 1, 1], 'Beam,1');
    const engine = createClashEngine({ backend: 'ts' });
    const result = await engine.run([pipe, beam], [{ id: 'mep-vs-str', name: 'MEP vs STR', a: 'IfcPipeSegment', b: 'IfcBeam', mode: 'hard' }]);
    expect(result.clashes).toHaveLength(1);

    const [row] = clashTableRows(result.clashes, { modelNameOf: (id) => id.replace('.ifc', '') });
    expect(row.Rule).toBe('mep-vs-str');
    expect(row.Status).toBe('hard');
    // Column A is the engine's `a`, column B its `b` — never crossed. The
    // engine decides which element is `a`, so read that off the result.
    const [c] = result.clashes;
    const [pipeSide, beamSide] = c.a.key === GUID_A ? (['A', 'B'] as const) : (['B', 'A'] as const);
    expect(row[`GlobalId${pipeSide}`]).toBe(GUID_A);
    expect(row[`Key${pipeSide}`]).toBe(GUID_A);
    expect(row[`Type${pipeSide}`]).toBe('IfcPipeSegment');
    expect(row[`Name${pipeSide}`]).toBe('Pipe 1');
    expect(row[`Model${pipeSide}`]).toBe('mep');
    expect(row[`GlobalId${beamSide}`]).toBe(GUID_B);
    expect(row[`Key${beamSide}`]).toBe(`${GUID_B}:occ-1`);
    expect(row[`Type${beamSide}`]).toBe('IfcBeam');
    expect(row[`Name${beamSide}`]).toBe('Beam,1');
    expect(row[`Model${beamSide}`]).toBe('str');
    // Half a unit of overlap along X: penetration, so the distance is negative.
    expect(row.Distance).toBeLessThan(0);
    expect(row.Distance).toBeCloseTo(-0.5, 3);
    expect(row.DistanceKind).toBe('mesh');
    expect(row.Review).toBe('open');
    expect(row.ReviewUpdatedAt).toBe('');
  });

  it('joins the review by clashReviewKey regardless of a/b order, and formats the edit time as ISO-8601', () => {
    const c = clash({ id: 'c1', a: ref(GUID_A, 'IfcWall'), b: ref(GUID_B, 'IfcDoor') });
    const swapped = clash({ id: 'c1', a: c.b, b: c.a });
    const reviews = new Map<string, ClashReview>([
      [clashReviewKey(swapped), { status: 'accepted', comment: 'by design', updatedAt: Date.UTC(2026, 8, 12, 10, 30) }],
    ]);
    const [row] = clashTableRows([c], { reviews });
    expect(row.Review).toBe('accepted');
    expect(row.ReviewComment).toBe('by design');
    expect(row.ReviewUpdatedAt).toBe('2026-09-12T10:30:00.000Z');
  });

  it('fills storey and group from the callbacks and leaves them empty when unknown', () => {
    const c1 = clash({ id: 'c1', a: ref(GUID_A, 'IfcWall'), b: ref(GUID_B, 'IfcDoor') });
    const c2 = clash({ id: 'c2', a: ref('expressid:m:9', 'IfcSlab'), b: ref(GUID_B, 'IfcDoor'), point: [9, 9, 9] });
    const groups = groupClashes(
      { clashes: [c1, c2], summary: { total: 2, byRule: {}, byTypePair: {}, bySeverity: { critical: 0, major: 2, minor: 0, info: 0 } }, rulesRun: [], settings: { tolerance: 0.002, excludeVoidsAndHosts: true } },
      { by: 'rule' },
    );
    const rows = clashTableRows([c1, c2], {
      groups,
      storeyOf: (r) => (r.key === GUID_A ? 'Level 1' : undefined),
    });
    expect(rows[0].StoreyA).toBe('Level 1');
    expect(rows[0].StoreyB).toBe('');
    expect(rows[1].GlobalIdA).toBe('');
    expect(rows[1].KeyA).toBe('expressid:m:9');
    expect(rows.map((r) => r.Group)).toEqual([groups[0].title, groups[0].title]);
  });

  it('serialises through the shared CSV writer with the documented header and a formula guard on names', () => {
    const c = clash({
      id: 'c1',
      a: ref(GUID_A, 'IfcWall', 'm', '=HYPERLINK("x")'),
      b: ref(GUID_B, 'IfcDoor', 'm', 'Door, left'),
    });
    const csv = tableToCsv(CLASH_TABLE_COLUMNS, clashTableRows([c]));
    // The documented contract, spelled out — not derived from the production
    // constant, so a reordered or dropped column fails here and in the docs.
    expect(csv).toBe(
      'ClashId,Rule,Status,Severity,Review,ReviewComment,ReviewUpdatedAt,'
      + 'GlobalIdA,GlobalIdB,KeyA,KeyB,ModelA,ModelB,TypeA,TypeB,NameA,NameB,StoreyA,StoreyB,'
      + 'PointX,PointY,PointZ,Distance,DistanceKind,Group' + LF
      + `c1,r,hard,major,open,,,${GUID_A},${GUID_B},${GUID_A},${GUID_B},m,m,IfcWall,IfcDoor,`
      + String.raw`"'=HYPERLINK(""x"")","Door, left",,,1,2,3,-0.05,,` + LF,
    );
  });
});
