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

  it('is empty for a synthetic expressid key and for a USD prim path, so a reader cannot join on a non-GUID', () => {
    expect(bareIfcGuid('expressid:model.ifc:42')).toBe('');
    expect(bareIfcGuid('/Site/Building/Wall_1')).toBe('');
    expect(bareIfcGuid('')).toBe('');
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
    expect(new Set([row.GlobalIdA, row.GlobalIdB])).toEqual(new Set([GUID_A, GUID_B]));
    expect(new Set([row.KeyA, row.KeyB])).toEqual(new Set([GUID_A, `${GUID_B}:occ-1`]));
    expect(new Set([row.TypeA, row.TypeB])).toEqual(new Set(['IfcPipeSegment', 'IfcBeam']));
    expect(new Set([row.NameA, row.NameB])).toEqual(new Set(['Pipe 1', 'Beam,1']));
    expect(new Set([row.ModelA, row.ModelB])).toEqual(new Set(['mep', 'str']));
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
    const [header, line] = csv.split('\n');
    expect(header).toBe(CLASH_TABLE_COLUMNS.join(','));
    expect(line).toContain(String.raw`"'=HYPERLINK(""x"")"`);
    expect(line).toContain('"Door, left"');
    expect(line.split(',').length).toBeGreaterThanOrEqual(CLASH_TABLE_COLUMNS.length);
  });
});
