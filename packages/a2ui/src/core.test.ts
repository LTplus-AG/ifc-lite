/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { validateIfcMessages } from './agent.js';
import { buildSurface } from './builders.js';
import { eventToFollowUp } from './policy.js';
import { describeQuery, matchesCondition, normalizeQuery, parseFieldPath } from './query.js';
import { encodeRef, parseRef, parseRefs } from './refs.js';

describe('entity refs', () => {
  it('round-trips and splits on the last colon', () => {
    expect(parseRef(encodeRef({ modelId: 'arch', expressId: 42 }))).toEqual({ modelId: 'arch', expressId: 42 });
    expect(parseRef('urn:model:7:42')).toEqual({ modelId: 'urn:model:7', expressId: 42 });
  });

  it.each(['42', ':42', 'arch:', 'arch:0', 'arch:-1', 'arch:1.5', 'arch:9007199254740993', 42, null])('rejects %p', (v) => {
    expect(parseRef(v)).toBeNull();
  });

  it('dedupes lists', () => {
    expect(parseRefs(['a:1', 'a:1', 'b:1', 'bad'])).toEqual([{ modelId: 'a', expressId: 1 }, { modelId: 'b', expressId: 1 }]);
  });
});

describe('query spec', () => {
  it('parses field paths', () => {
    expect(parseFieldPath('storey')).toEqual({ kind: 'builtin', key: 'storey' });
    expect(parseFieldPath('GlobalId')).toEqual({ kind: 'builtin', key: 'globalId' });
    expect(parseFieldPath('PredefinedType')).toEqual({ kind: 'attribute', name: 'PredefinedType' });
    expect(parseFieldPath('Pset_DoorCommon.FireRating')).toEqual({ kind: 'property', set: 'Pset_DoorCommon', name: 'FireRating' });
    expect(parseFieldPath('.x')).toBeNull();
    expect(parseFieldPath('a b')).toBeNull();
  });

  it('normalises types and clamps the limit', () => {
    const { spec, problems } = normalizeQuery({ types: ['IfcDoor', 'ifcdoor', 'IfcWall'], limit: 1e9 });
    expect(problems).toEqual([]);
    expect(spec).toEqual({ types: ['IFCDOOR', 'IFCWALL'], limit: 5000 });
  });

  it('reports bad input instead of guessing', () => {
    const { problems } = normalizeQuery({ types: ['Door'], where: [{ path: 'Name', op: 'like', value: 'x' }, { path: 'Name', op: 'eq' }] });
    expect(problems.map((p) => p.path)).toEqual(['types', 'where[0].op', 'where[1].value']);
    expect(normalizeQuery('IfcDoor').problems).toHaveLength(1);
    // A malformed storey, model or limit is reported, not dropped into a wider query.
    expect(normalizeQuery({ types: ['IfcDoor'], storey: ['EG'], modelId: 7, limit: '10' }).problems.map((p) => p.path)).toEqual(['storey', 'modelId', 'limit']);
  });

  it('matches conditions', () => {
    expect(matchesCondition('EI30', { path: 'x', op: 'eq', value: 'ei30' })).toBe(true);
    expect(matchesCondition(undefined, { path: 'x', op: 'missing' })).toBe(true);
    expect(matchesCondition('', { path: 'x', op: 'missing' })).toBe(true);
    expect(matchesCondition(undefined, { path: 'x', op: 'neq', value: 'a' })).toBe(true);
    expect(matchesCondition('12.5', { path: 'x', op: 'gt', value: 10 })).toBe(true);
    expect(matchesCondition('abc', { path: 'x', op: 'gt', value: 10 })).toBe(false);
    expect(matchesCondition('TRUE', { path: 'x', op: 'eq', value: true })).toBe(true);
    expect(matchesCondition('Fire door', { path: 'x', op: 'contains', value: 'FIRE' })).toBe(true);
  });

  it('describes a query', () => {
    expect(describeQuery({ types: ['IFCDOOR'], storey: 'EG', where: [{ path: 'Pset_DoorCommon.FireRating', op: 'missing' }] })).toBe(
      'IFCDOOR · on EG · Pset_DoorCommon.FireRating missing',
    );
  });
});

describe('builders', () => {
  it('produce payloads the catalog accepts, with every value bound', () => {
    const messages = buildSurface({
      surfaceId: 'script-1',
      title: 'Door check',
      sections: [
        { kind: 'stats', items: [{ label: 'Doors', value: 12 }, { label: 'Walls', query: { types: ['IfcWall'] } }] },
        { kind: 'table', columns: [{ path: 'name' }, { path: 'rating', label: 'Rating' }], rows: [{ ref: 'arch:1', name: 'D1', rating: 'EI30' }] },
        { kind: 'chart', groupBy: 'storey', data: [{ label: 'EG', value: 3, refs: ['arch:1'] }] },
        { kind: 'legend', by: 'type', query: { types: ['IfcWall'] } },
        { kind: 'actions', actions: ['isolate', 'flyTo'], refs: ['arch:1'] },
        { kind: 'callout', text: 'One door lacks a rating', tone: 'warn' },
        { kind: 'entity', entity: 'arch:1' },
        { kind: 'list', refs: ['arch:1'] },
        { kind: 'text', text: 'Done', variant: 'caption' },
      ],
    });
    expect(validateIfcMessages(messages)).toEqual([]);
    const surface = messages[0].createSurface;
    expect(surface.dataModel).toMatchObject({ s0: { v0: 12 }, s1: { rows: [{ ref: 'arch:1' }] } });
    expect(JSON.stringify(surface.components)).not.toContain('EI30');
  });

  it('rejects unsafe surface ids', () => {
    expect(() => buildSurface({ surfaceId: 'a b', sections: [] })).toThrow(/surfaceId/);
  });
});

describe('follow-ups', () => {
  it('turns ask events into the prompt and other events into a described action', () => {
    expect(eventToFollowUp('ask', { prompt: ' Why? ' })).toEqual({ userText: 'Why?', context: { prompt: ' Why? ' } });
    expect(eventToFollowUp('approve', { id: 3 }, 'Approve fix')).toEqual({ userText: 'Approve fix', context: { event: 'approve', id: 3 } });
    expect(eventToFollowUp('approve', undefined).userText).toBe('Action: approve');
  });
});

describe('chart folding (#11344)', () => {
  it('resolves maxGroups like every renderer: floor, below 2 is the default, capped', async () => {
    const { resolveMaxGroups, DEFAULT_MAX_GROUPS } = await import('./charts.js');
    expect([resolveMaxGroups(undefined), resolveMaxGroups(1), resolveMaxGroups(1.5), resolveMaxGroups(2.9), resolveMaxGroups(1e6)])
      .toEqual([DEFAULT_MAX_GROUPS, DEFAULT_MAX_GROUPS, DEFAULT_MAX_GROUPS, 2, 100]);
  });
});
