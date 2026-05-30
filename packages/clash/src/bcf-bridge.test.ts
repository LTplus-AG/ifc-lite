/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { readBCF } from '@ifc-lite/bcf';
import type {
  AABB,
  Clash,
  ClashElementRef,
  ClashGroup,
  ClashResult,
  ClashSeverity,
  ClashStatus,
} from './types.js';
import { createBCFFromClashResult, mapBcfToClashes } from './bcf-bridge.js';
import { uuidFromSeed } from './deterministic-uuid.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function ref(key: string, tag: string, name?: string): ClashElementRef {
  return { key, ref: key.length, model: 'm', tag, name };
}

function bounds(min: [number, number, number], max: [number, number, number]): AABB {
  return { min, max };
}

function clash(
  id: string,
  a: ClashElementRef,
  b: ClashElementRef,
  status: ClashStatus,
  severity: ClashSeverity,
  rule: string,
): Clash {
  return {
    id,
    a,
    b,
    rule,
    status,
    distance: status === 'hard' ? -0.01 : 0.02,
    point: [1, 2, 3],
    bounds: bounds([0, 0, 0], [1, 1, 1]),
    severity,
  };
}

function makeGroup(
  id: string,
  severity: ClashSeverity,
  members: Clash[],
  discipline?: string,
  storey?: string,
): ClashGroup {
  return {
    id,
    title: `Group ${id}`,
    members,
    bounds: bounds([0, 0, 0], [4, 3, 2]),
    representativePoint: [2, 1.5, 1],
    severity,
    discipline,
    storey,
  };
}

function makeFixture(): { result: ClashResult; groups: ClashGroup[] } {
  const c1 = clash(
    'clash-1',
    ref('GUID_A1', 'IfcPipeSegment', 'Pipe-1'),
    ref('GUID_B1', 'IfcBeam', 'Beam-1'),
    'hard',
    'critical',
    'MEPxSTR',
  );
  const c2 = clash(
    'clash-2',
    ref('GUID_A1', 'IfcPipeSegment', 'Pipe-1'),
    ref('GUID_B2', 'IfcColumn'),
    'hard',
    'critical',
    'MEPxSTR',
  );
  const c3 = clash(
    'clash-3',
    ref('GUID_C1', 'IfcDuctSegment'),
    ref('GUID_D1', 'IfcWall'),
    'clearance',
    'major',
    'HVACxARCH',
  );
  const c4 = clash(
    'clash-4',
    ref('GUID_E1', 'IfcCableSegment'),
    ref('GUID_F1', 'IfcPipeSegment'),
    'clearance',
    'minor',
    'ELECxMEP',
  );

  const g1 = makeGroup('group-critical', 'critical', [c1, c2], 'MEP', 'Level 1');
  const g2 = makeGroup('group-major', 'major', [c3], 'HVAC', 'Level 2');
  const g3 = makeGroup('group-minor', 'minor', [c4], 'ELEC');

  const clashes = [c1, c2, c3, c4];
  const result: ClashResult = {
    clashes,
    summary: {
      total: clashes.length,
      byRule: { MEPxSTR: 2, HVACxARCH: 1, ELECxMEP: 1 },
      byTypePair: {},
      bySeverity: { critical: 2, major: 1, minor: 1, info: 0 },
    },
    rulesRun: [],
    settings: { tolerance: 0.002, excludeVoidsAndHosts: true },
  };

  return { result, groups: [g1, g2, g3] };
}

describe('createBCFFromClashResult', () => {
  it('creates one topic per group with deterministic guids', async () => {
    const { result, groups } = makeFixture();
    const project = await createBCFFromClashResult(result, groups, { author: 'tester' });

    expect(project.version).toBe('2.1');
    expect(project.topics.size).toBe(groups.length);

    for (const group of groups) {
      const expectedGuid = uuidFromSeed(group.id);
      expect(project.topics.has(expectedGuid)).toBe(true);
      const topic = project.topics.get(expectedGuid);
      expect(topic).toBeDefined();
      expect(topic?.guid).toBe(expectedGuid);
      expect(topic?.guid).toMatch(UUID_RE);
    }
  });

  it('sorts critical groups first and maps severity to priority', async () => {
    const { result, groups } = makeFixture();
    const project = await createBCFFromClashResult(result, groups, { author: 'tester' });

    const critical = project.topics.get(uuidFromSeed('group-critical'));
    const major = project.topics.get(uuidFromSeed('group-major'));
    const minor = project.topics.get(uuidFromSeed('group-minor'));

    expect(critical?.priority).toBe('High');
    expect(major?.priority).toBe('Normal');
    expect(minor?.priority).toBe('Low');

    // Discipline + 'Clash' labels.
    expect(critical?.labels).toEqual(['MEP', 'Clash']);
    // Minor group carries its discipline plus 'Clash'.
    expect(minor?.labels).toEqual(['ELEC', 'Clash']);
  });

  it('omits a missing discipline from the labels', async () => {
    const { result } = makeFixture();
    const lone = clash(
      'clash-lone',
      ref('GUID_X1', 'IfcSlab'),
      ref('GUID_Y1', 'IfcDuctSegment'),
      'hard',
      'info',
      'rule',
    );
    const noDiscipline = makeGroup('group-no-discipline', 'info', [lone]);
    const project = await createBCFFromClashResult(result, [noDiscipline], { author: 'tester' });
    const topic = project.topics.get(uuidFromSeed('group-no-discipline'));
    // No discipline -> just 'Clash'.
    expect(topic?.labels).toEqual(['Clash']);
  });

  it('embeds an uncapped clash-ids line plus a capped member table', async () => {
    const { result, groups } = makeFixture();
    const project = await createBCFFromClashResult(result, groups, {
      author: 'tester',
      maxMembersPerTopic: 1,
    });

    const critical = project.topics.get(uuidFromSeed('group-critical'));
    expect(critical?.description).toContain('clash-ids: clash-1,clash-2');
    // Member table is capped at 1 -> "and 1 more".
    expect(critical?.description).toContain('and 1 more');
  });

  it('produces identical guids on repeated calls (determinism)', async () => {
    const { result, groups } = makeFixture();
    const a = await createBCFFromClashResult(result, groups, { author: 'tester' });
    const b = await createBCFFromClashResult(result, groups, { author: 'tester' });
    expect([...a.topics.keys()].sort()).toEqual([...b.topics.keys()].sort());
  });

  it('attaches a framing viewpoint with selection and coloring', async () => {
    const { result, groups } = makeFixture();
    const project = await createBCFFromClashResult(result, groups, { author: 'tester' });
    const critical = project.topics.get(uuidFromSeed('group-critical'));
    expect(critical?.viewpoints.length).toBe(1);
    const vp = critical?.viewpoints[0];
    expect(vp?.components?.selection?.length).toBeGreaterThan(0);
    expect(vp?.components?.coloring?.length).toBe(2);
    expect(vp?.perspectiveCamera).toBeDefined();
  });

  it('invokes the snapshot provider per group', async () => {
    const { result, groups } = makeFixture();
    const seen: string[] = [];
    const snapshotProvider = async (g: ClashGroup): Promise<Uint8Array> => {
      seen.push(g.id);
      return new Uint8Array([1, 2, 3, 4]);
    };
    const project = await createBCFFromClashResult(result, groups, {
      author: 'tester',
      snapshotProvider,
    });
    expect(seen.sort()).toEqual(['group-critical', 'group-major', 'group-minor']);
    const critical = project.topics.get(uuidFromSeed('group-critical'));
    expect(critical?.viewpoints[0]?.snapshotData).toBeInstanceOf(Uint8Array);
  });

  it('caps topics at maxTopics and adds a transparency overflow topic', async () => {
    const { result, groups } = makeFixture();
    const maxTopics = 2;
    const project = await createBCFFromClashResult(result, groups, {
      author: 'tester',
      maxTopics,
    });

    // 2 exported + 1 overflow marker.
    expect(project.topics.size).toBe(maxTopics + 1);

    const overflow = [...project.topics.values()].find((t) =>
      t.title.includes('more clash groups not exported'),
    );
    expect(overflow).toBeDefined();
    expect(overflow?.title).toContain('1 more clash groups not exported');
    expect(overflow?.description).toContain('exceeded the maxTopics cap of 2');

    // The two exported topics are the two most severe groups.
    expect(project.topics.has(uuidFromSeed('group-critical'))).toBe(true);
    expect(project.topics.has(uuidFromSeed('group-major'))).toBe(true);
    expect(project.topics.has(uuidFromSeed('group-minor'))).toBe(false);
  });
});

describe('mapBcfToClashes', () => {
  it('recovers every clash id -> status from an in-memory project', async () => {
    const { result, groups } = makeFixture();
    const project = await createBCFFromClashResult(result, groups, {
      author: 'tester',
      status: 'In Progress',
    });
    const map = mapBcfToClashes(project);

    expect(map.size).toBe(4);
    expect(map.get('clash-1')?.status).toBe('In Progress');
    expect(map.get('clash-1')?.topicGuid).toBe(uuidFromSeed('group-critical'));
    expect(map.get('clash-2')?.topicGuid).toBe(uuidFromSeed('group-critical'));
    expect(map.get('clash-3')?.topicGuid).toBe(uuidFromSeed('group-major'));
    expect(map.get('clash-4')?.topicGuid).toBe(uuidFromSeed('group-minor'));
  });
});

describe('BCF round-trip', () => {
  it('writes a Blob, reads it back, and recovers every clash id', async () => {
    const { result, groups } = makeFixture();
    const { writeBCF } = await import('@ifc-lite/bcf');
    const project = await createBCFFromClashResult(result, groups, {
      author: 'tester',
      status: 'Open',
    });

    const blob = await writeBCF(project);
    expect(blob).toBeInstanceOf(Blob);

    const buffer = await blob.arrayBuffer();
    const reloaded = await readBCF(buffer);

    const map = mapBcfToClashes(reloaded);
    expect(map.size).toBe(4);
    for (const id of ['clash-1', 'clash-2', 'clash-3', 'clash-4']) {
      expect(map.has(id)).toBe(true);
      expect(map.get(id)?.status).toBe('Open');
    }

    // Topic guids survive the round-trip and remain the deterministic ones.
    expect(map.get('clash-1')?.topicGuid).toBe(uuidFromSeed('group-critical'));
    expect(map.get('clash-3')?.topicGuid).toBe(uuidFromSeed('group-major'));
  });
});

describe('uuidFromSeed', () => {
  it('is deterministic and RFC-4122-shaped', () => {
    const a = uuidFromSeed('group-critical');
    const b = uuidFromSeed('group-critical');
    expect(a).toBe(b);
    expect(a).toMatch(UUID_RE);
  });

  it('forces the version nibble to 4 and a valid variant nibble', () => {
    for (const seed of ['a', 'b', 'group-1', 'group-2', '', 'x'.repeat(200)]) {
      const uuid = uuidFromSeed(seed);
      expect(uuid).toMatch(UUID_RE);
      expect(uuid[14]).toBe('4');
      expect('89ab').toContain(uuid[19]);
    }
  });

  it('diffuses similar seeds into different uuids', () => {
    const u1 = uuidFromSeed('group-1');
    const u2 = uuidFromSeed('group-2');
    expect(u1).not.toBe(u2);
  });
});
