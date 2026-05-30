/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { groupClashes } from './grouping.js';
import type {
  AABB,
  Clash,
  ClashElementRef,
  ClashResult,
  ClashSeverity,
  Vec3,
} from './types.js';

function ref(key: string, tag: string, name?: string): ClashElementRef {
  const r: ClashElementRef = { key, ref: 1, model: 'm', tag };
  if (name !== undefined) r.name = name;
  return r;
}

function boundsAround(p: Vec3, half = 0.1): AABB {
  return {
    min: [p[0] - half, p[1] - half, p[2] - half],
    max: [p[0] + half, p[1] + half, p[2] + half],
  };
}

interface ClashSpec {
  id: string;
  a: ClashElementRef;
  b: ClashElementRef;
  rule: string;
  point: Vec3;
  severity?: ClashSeverity;
}

function clash(spec: ClashSpec): Clash {
  return {
    id: spec.id,
    a: spec.a,
    b: spec.b,
    rule: spec.rule,
    status: 'hard',
    distance: -0.01,
    point: spec.point,
    bounds: boundsAround(spec.point),
    severity: spec.severity ?? 'major',
  };
}

function makeResult(clashes: Clash[]): ClashResult {
  return {
    clashes,
    summary: {
      total: clashes.length,
      byRule: {},
      byTypePair: {},
      bySeverity: { critical: 0, major: 0, minor: 0, info: 0 },
    },
    rulesRun: [],
    settings: { tolerance: 0.002, excludeVoidsAndHosts: true },
  };
}

const PIPE = ref('A', 'IfcPipeSegment');
const BEAM = ref('B', 'IfcBeam');
const PIPE2 = ref('C', 'IfcPipeSegment');
const BEAM2 = ref('D', 'IfcBeam');

describe('groupClashes — cluster', () => {
  it('collapses co-located same-rule same-type-pair clashes and keeps a far one apart', () => {
    const clashes = [
      clash({ id: 'c1', a: PIPE, b: BEAM, rule: 'MEPxSTR', point: [0, 0, 0] }),
      clash({ id: 'c2', a: PIPE, b: BEAM, rule: 'MEPxSTR', point: [0.5, 0, 0] }),
      clash({ id: 'c3', a: PIPE2, b: BEAM2, rule: 'MEPxSTR', point: [100, 0, 0] }),
    ];
    const groups = groupClashes(makeResult(clashes), { by: 'cluster' });
    expect(groups).toHaveLength(2);
    const counts = groups.map((g) => g.members.length).sort((x, y) => y - x);
    expect(counts).toEqual([2, 1]);
  });

  it('transitively joins a chain within epsilon', () => {
    const clashes = [
      clash({ id: 'c1', a: PIPE, b: BEAM, rule: 'MEPxSTR', point: [0, 0, 0] }),
      clash({ id: 'c2', a: PIPE, b: BEAM, rule: 'MEPxSTR', point: [1.0, 0, 0] }),
      clash({ id: 'c3', a: PIPE, b: BEAM, rule: 'MEPxSTR', point: [2.0, 0, 0] }),
    ];
    // epsilon 1.5: c1-c2 (1.0) and c2-c3 (1.0) join; c1-c3 (2.0) joins via c2.
    const groups = groupClashes(makeResult(clashes), { by: 'cluster', epsilon: 1.5 });
    expect(groups).toHaveLength(1);
    expect(groups[0].members).toHaveLength(3);
  });

  it('keeps different rules apart even when co-located', () => {
    const clashes = [
      clash({ id: 'c1', a: PIPE, b: BEAM, rule: 'MEPxSTR', point: [0, 0, 0] }),
      clash({ id: 'c2', a: PIPE, b: BEAM, rule: 'HVACxSTR', point: [0, 0, 0] }),
    ];
    const groups = groupClashes(makeResult(clashes), { by: 'cluster' });
    expect(groups).toHaveLength(2);
    for (const g of groups) expect(g.members).toHaveLength(1);
  });

  it('keeps different type-pairs apart even when co-located and same rule', () => {
    const duct = ref('E', 'IfcDuctSegment');
    const clashes = [
      clash({ id: 'c1', a: PIPE, b: BEAM, rule: 'R', point: [0, 0, 0] }),
      clash({ id: 'c2', a: duct, b: BEAM, rule: 'R', point: [0, 0, 0] }),
    ];
    const groups = groupClashes(makeResult(clashes), { by: 'cluster' });
    expect(groups).toHaveLength(2);
  });

  it('treats type-pair order-independently (a,b vs b,a join)', () => {
    const clashes = [
      clash({ id: 'c1', a: PIPE, b: BEAM, rule: 'R', point: [0, 0, 0] }),
      clash({ id: 'c2', a: BEAM, b: PIPE, rule: 'R', point: [0.2, 0, 0] }),
    ];
    const groups = groupClashes(makeResult(clashes), { by: 'cluster' });
    expect(groups).toHaveLength(1);
    expect(groups[0].members).toHaveLength(2);
  });
});

describe('groupClashes — rule / typePair / element', () => {
  it('rule: one group per distinct rule', () => {
    const clashes = [
      clash({ id: 'c1', a: PIPE, b: BEAM, rule: 'MEPxSTR', point: [0, 0, 0] }),
      clash({ id: 'c2', a: PIPE, b: BEAM, rule: 'MEPxSTR', point: [50, 0, 0] }),
      clash({ id: 'c3', a: PIPE, b: BEAM, rule: 'HVACxSTR', point: [0, 0, 0] }),
    ];
    const groups = groupClashes(makeResult(clashes), { by: 'rule' });
    expect(groups).toHaveLength(2);
    const byRule = new Map(groups.map((g) => [g.members[0].rule, g.members.length]));
    expect(byRule.get('MEPxSTR')).toBe(2);
    expect(byRule.get('HVACxSTR')).toBe(1);
  });

  it('rule: title and discipline map from presets', () => {
    const clashes = [clash({ id: 'c1', a: PIPE, b: BEAM, rule: 'MEPxSTR', point: [0, 0, 0] })];
    const [group] = groupClashes(makeResult(clashes), { by: 'rule' });
    expect(group.discipline).toBe('MEP vs Structure');
    expect(group.title).toContain('MEP vs Structure');
    expect(group.title).toContain('MEPxSTR');
  });

  it('typePair: one group per distinct sorted type-pair', () => {
    const duct = ref('E', 'IfcDuctSegment');
    const clashes = [
      clash({ id: 'c1', a: PIPE, b: BEAM, rule: 'R1', point: [0, 0, 0] }),
      clash({ id: 'c2', a: BEAM, b: PIPE, rule: 'R2', point: [9, 0, 0] }),
      clash({ id: 'c3', a: duct, b: BEAM, rule: 'R1', point: [0, 0, 0] }),
    ];
    const groups = groupClashes(makeResult(clashes), { by: 'typePair' });
    // (IfcBeam,IfcPipeSegment) x2 across rules; (IfcBeam,IfcDuctSegment) x1.
    expect(groups).toHaveLength(2);
    const counts = groups.map((g) => g.members.length).sort((x, y) => y - x);
    expect(counts).toEqual([2, 1]);
  });

  it('element: a clash contributes to BOTH element keys', () => {
    const clashes = [
      clash({ id: 'c1', a: PIPE, b: BEAM, rule: 'R', point: [0, 0, 0] }),
      clash({ id: 'c2', a: PIPE, b: BEAM2, rule: 'R', point: [5, 0, 0] }),
    ];
    const groups = groupClashes(makeResult(clashes), { by: 'element' });
    // Keys A (pipe, both clashes), B (beam, c1), D (beam2, c2).
    expect(groups).toHaveLength(3);
    const byTitleCount = groups.map((g) => g.members.length).sort((x, y) => y - x);
    expect(byTitleCount).toEqual([2, 1, 1]);
    const pipeGroup = groups.find((g) => g.members.length === 2);
    expect(pipeGroup?.title).toContain('IfcPipeSegment');
    expect(pipeGroup?.title).toContain('A');
  });

  it('element: title prefers element name when present', () => {
    const named = ref('Z', 'IfcPipeSegment', 'Riser-1');
    const clashes = [clash({ id: 'c1', a: named, b: BEAM, rule: 'R', point: [0, 0, 0] })];
    const groups = groupClashes(makeResult(clashes), { by: 'element' });
    const namedGroup = groups.find((g) => g.title.includes('Riser-1'));
    expect(namedGroup).toBeDefined();
  });
});

describe('groupClashes — storey fallback', () => {
  it('degrades storey to rule grouping (no storey field on Clash)', () => {
    const clashes = [
      clash({ id: 'c1', a: PIPE, b: BEAM, rule: 'MEPxSTR', point: [0, 0, 0] }),
      clash({ id: 'c2', a: PIPE, b: BEAM, rule: 'HVACxSTR', point: [0, 0, 0] }),
    ];
    const storey = groupClashes(makeResult(clashes), { by: 'storey' });
    const rule = groupClashes(makeResult(clashes), { by: 'rule' });
    expect(storey.map((g) => g.id)).toEqual(rule.map((g) => g.id));
  });
});

describe('groupClashes — aggregates', () => {
  it('severity is the max among members', () => {
    const clashes = [
      clash({ id: 'c1', a: PIPE, b: BEAM, rule: 'R', point: [0, 0, 0], severity: 'minor' }),
      clash({ id: 'c2', a: PIPE, b: BEAM, rule: 'R', point: [0.3, 0, 0], severity: 'critical' }),
      clash({ id: 'c3', a: PIPE, b: BEAM, rule: 'R', point: [0.6, 0, 0], severity: 'major' }),
    ];
    const [group] = groupClashes(makeResult(clashes), { by: 'cluster' });
    expect(group.members).toHaveLength(3);
    expect(group.severity).toBe('critical');
  });

  it('bounds union and mean representative point', () => {
    const clashes = [
      clash({ id: 'c1', a: PIPE, b: BEAM, rule: 'R', point: [0, 0, 0] }),
      clash({ id: 'c2', a: PIPE, b: BEAM, rule: 'R', point: [1, 0, 0] }),
    ];
    const [group] = groupClashes(makeResult(clashes), { by: 'cluster', epsilon: 2 });
    expect(group.representativePoint).toEqual([0.5, 0, 0]);
    // bounds half-size 0.1 around each point => min -0.1, max 1.1.
    expect(group.bounds.min[0]).toBeCloseTo(-0.1, 6);
    expect(group.bounds.max[0]).toBeCloseTo(1.1, 6);
  });

  it('sorts groups by severity then member count desc', () => {
    const clashes = [
      // major group with 1 member
      clash({ id: 'c1', a: PIPE, b: BEAM, rule: 'major-rule', point: [0, 0, 0], severity: 'major' }),
      // critical group with 2 members
      clash({ id: 'c2', a: PIPE, b: BEAM, rule: 'crit-rule', point: [10, 0, 0], severity: 'critical' }),
      clash({ id: 'c3', a: PIPE, b: BEAM, rule: 'crit-rule', point: [10.3, 0, 0], severity: 'critical' }),
    ];
    const groups = groupClashes(makeResult(clashes), { by: 'cluster' });
    expect(groups[0].severity).toBe('critical');
    expect(groups[0].members).toHaveLength(2);
    expect(groups[1].severity).toBe('major');
  });
});

describe('groupClashes — determinism', () => {
  it('produces identical ids for the same input twice', () => {
    const build = (): ClashResult =>
      makeResult([
        clash({ id: 'c1', a: PIPE, b: BEAM, rule: 'R', point: [0, 0, 0] }),
        clash({ id: 'c2', a: PIPE, b: BEAM, rule: 'R', point: [0.4, 0, 0] }),
        clash({ id: 'c3', a: PIPE2, b: BEAM2, rule: 'R2', point: [50, 0, 0] }),
      ]);
    const first = groupClashes(build(), { by: 'cluster' });
    const second = groupClashes(build(), { by: 'cluster' });
    expect(first.map((g) => g.id)).toEqual(second.map((g) => g.id));
    // Group id is independent of member input order.
    const reversed = makeResult([
      clash({ id: 'c2', a: PIPE, b: BEAM, rule: 'R', point: [0.4, 0, 0] }),
      clash({ id: 'c1', a: PIPE, b: BEAM, rule: 'R', point: [0, 0, 0] }),
      clash({ id: 'c3', a: PIPE2, b: BEAM2, rule: 'R2', point: [50, 0, 0] }),
    ]);
    const third = groupClashes(reversed, { by: 'cluster' });
    expect(new Set(third.map((g) => g.id))).toEqual(new Set(first.map((g) => g.id)));
  });

  it('id has the grp- prefix and a stable hex hash', () => {
    const clashes = [clash({ id: 'c1', a: PIPE, b: BEAM, rule: 'R', point: [0, 0, 0] })];
    const [group] = groupClashes(makeResult(clashes), { by: 'cluster' });
    expect(group.id).toMatch(/^grp-[0-9a-f]{8}$/);
  });
});
