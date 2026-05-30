/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression tests for defects found by adversarial review of phases 2/5/6:
 * - element-mode groups must not collide on the same id (-> duplicate BCF GUIDs)
 * - the BCF clash-ids round-trip must survive commas in a clash id
 * - the self-clash broad phase must skip same-key (same-entity) pairs
 */

import { describe, expect, it } from 'vitest';
import { readBCF, writeBCF } from '@ifc-lite/bcf';
import { groupClashes } from './grouping.js';
import { createBCFFromClashResult, mapBcfToClashes } from './bcf-bridge.js';
import { createClashEngine } from './engine.js';
import type { AABB, Clash, ClashElement, ClashElementRef, ClashResult, Vec3 } from './types.js';

function ref(key: string, tag: string): ClashElementRef {
  return { key, ref: 1, model: 'm', tag };
}

function boundsAround(p: Vec3): AABB {
  return { min: [p[0] - 0.1, p[1] - 0.1, p[2] - 0.1], max: [p[0] + 0.1, p[1] + 0.1, p[2] + 0.1] };
}

function makeClash(id: string, a: ClashElementRef, b: ClashElementRef, point: Vec3): Clash {
  return {
    id, a, b, rule: 'r', status: 'hard', distance: -0.01,
    point, bounds: boundsAround(point), severity: 'major',
  };
}

function makeResult(clashes: Clash[]): ClashResult {
  return {
    clashes,
    summary: {
      total: clashes.length,
      byRule: {}, byTypePair: {},
      bySeverity: { critical: 0, major: 0, minor: 0, info: 0 },
    },
    rulesRun: [],
    settings: { tolerance: 0.002, excludeVoidsAndHosts: true },
  };
}

function boxElement(key: string, tag: string, cx: number): ClashElement {
  const h = 0.5;
  const v = [
    cx - h, -h, -h, cx + h, -h, -h, cx + h, h, -h, cx - h, h, -h,
    cx - h, -h, h, cx + h, -h, h, cx + h, h, h, cx - h, h, h,
  ];
  const indices = new Uint32Array([
    0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1,
    1, 5, 6, 1, 6, 2, 2, 6, 7, 2, 7, 3, 3, 7, 4, 3, 4, 0,
  ]);
  const positions = new Float32Array(v);
  return {
    key, ref: 1, model: 'm', tag, positions, indices,
    bounds: { min: [cx - h, -h, -h], max: [cx + h, h, h] },
  };
}

describe('regression: element-mode group ids do not collide', () => {
  it('gives two elements that clash only with each other distinct group ids', () => {
    const a = ref('GUID-A', 'IfcPipeSegment');
    const b = ref('GUID-B', 'IfcBeam');
    const result = makeResult([makeClash('r m GUID-A m GUID-B', a, b, [0, 0, 0])]);

    const groups = groupClashes(result, { by: 'element' });
    expect(groups).toHaveLength(2);
    expect(groups[0].id).not.toBe(groups[1].id);
  });
});

describe('regression: BCF clash-ids round-trip survives commas in an id', () => {
  it('recovers a clash id containing a comma (federated model label)', async () => {
    // A realistic federated model label puts a comma inside the clash id.
    const commaId = 'r Building A, Phase 2.ifc GUID-A m GUID-B';
    const a = ref('GUID-A', 'IfcDuctSegment');
    const b = ref('GUID-B', 'IfcBeam');
    const result = makeResult([makeClash(commaId, a, b, [0, 0, 0])]);
    const groups = groupClashes(result, { by: 'rule' });

    const project = await createBCFFromClashResult(result, groups, { author: 'qa@example.com' });
    const reloaded = await readBCF(await (await writeBCF(project)).arrayBuffer());
    const map = mapBcfToClashes(reloaded);

    expect(map.has(commaId)).toBe(true);
    expect(map.get(commaId)?.status).toBe('Open');
  });
});

describe('regression: self-clash skips same-key (same-entity) pairs', () => {
  it('does not report a clash between two elements sharing a durable key', async () => {
    // An IFC5 element split across two geometry sub-prims -> two overlapping
    // ClashElements with the SAME key. That is one entity, not a clash.
    const elements = [boxElement('SAME', 'IfcWall', 0), boxElement('SAME', 'IfcWall', 0.2)];
    const engine = createClashEngine({ backend: 'ts' });
    const result = await engine.run(elements, [
      { id: 'self', name: 'wall self-clash', a: 'IfcWall', mode: 'hard' },
    ]);
    expect(result.summary.total).toBe(0);
  });
});
