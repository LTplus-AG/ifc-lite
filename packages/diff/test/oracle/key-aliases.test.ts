/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Tests for the identity-map CONSUMER (issue #1891):
 * `diffModels(..., { keyAliases })`.
 *
 * An alias is an accepted claim replayed as key normalization. The tests pin
 * three things: that it actually short-circuits the content pass (an aliased
 * pair is matched by key and never becomes a candidate), that every way of
 * being wrong degrades to today's behaviour instead of throwing or fabricating,
 * and that it composes with `excludeTypes` and every `scope`.
 */

import { describe, expect, it } from 'vitest';
import { diffModels } from './diff.js';
import type { EntityFingerprint } from './types.js';

function fp(
  key: string,
  opts: Partial<Omit<EntityFingerprint<number>, 'key'>> = {},
): EntityFingerprint<number> {
  return {
    key,
    ifcType: opts.ifcType ?? 'IfcWall',
    dataHash: opts.dataHash ?? 'd0',
    geometryHash: opts.geometryHash,
    ref: opts.ref ?? 0,
  };
}

describe('diffModels — keyAliases: the happy path', () => {
  it('a re-GUIDed identical element reads as unchanged instead of added + deleted', () => {
    const base = [fp('old', { dataHash: 'd1', geometryHash: 1n })];
    const head = [fp('new', { dataHash: 'd1', geometryHash: 1n })];

    const plain = diffModels(base, head);
    expect(plain.counts).toEqual({ added: 1, modified: 0, deleted: 1, unchanged: 0 });

    const aliased = diffModels(base, head, { keyAliases: new Map([['new', 'old']]) });
    expect(aliased.counts).toEqual({ added: 0, modified: 0, deleted: 0, unchanged: 1 });
    expect(aliased.appliedKeyAliases).toEqual(new Map([['new', 'old']]));
  });

  it('the entry is keyed by the BASE key, and neither fingerprint is rewritten', () => {
    const base = [fp('old', { dataHash: 'd1' })];
    const head = [fp('new', { dataHash: 'd2' })];

    const diff = diffModels(base, head, { keyAliases: new Map([['new', 'old']]) });
    const entry = diff.byKey.get('old');

    expect(entry?.state).toBe('modified');
    expect(entry?.changeKinds).toEqual(['data']);
    // The alias renames the PAIR, not the file: the head entity still reports
    // the GlobalId it actually carries.
    expect(entry?.head?.key).toBe('new');
    expect(entry?.base?.key).toBe('old');
    expect(diff.byKey.has('new')).toBe(false);
  });

  it('an aliased pair never reaches the content pass', () => {
    // Both walls share a data hash, so without the alias they would be a
    // content match. With it, they are simply not candidates.
    const base = [fp('old', { dataHash: 'd1', geometryHash: 1n })];
    const head = [fp('new', { dataHash: 'd1', geometryHash: 2n })];

    const content = diffModels(base, head, { matchUnpairedByContent: true });
    expect(content.contentMatches).toHaveLength(1);

    const aliased = diffModels(base, head, {
      matchUnpairedByContent: true,
      keyAliases: new Map([['new', 'old']]),
    });
    expect(aliased.contentMatches).toEqual([]);
    expect(aliased.byKey.get('old')?.changeKinds).toEqual(['geometry']);
  });

  it('is inert when no aliases are supplied', () => {
    const base = [fp('a', { dataHash: 'd1' })];
    const head = [fp('a', { dataHash: 'd1' })];
    const diff = diffModels(base, head, {});
    expect(diff.appliedKeyAliases).toBeUndefined();
    expect(diff.counts).toEqual({ added: 0, modified: 0, deleted: 0, unchanged: 1 });
  });
});

describe('diffModels — keyAliases: degrading gracefully', () => {
  it('a stale alias whose base key no longer exists changes nothing', () => {
    const base = [fp('still-here', { dataHash: 'd1' })];
    const head = [fp('new', { dataHash: 'd2' })];

    // The base entity the claim referred to was deleted since the map was
    // written.
    const diff = diffModels(base, head, { keyAliases: new Map([['new', 'gone']]) });

    expect(diff.counts).toEqual({ added: 1, modified: 0, deleted: 1, unchanged: 0 });
    expect(diff.byKey.get('new')?.state).toBe('added');
    expect(diff.byKey.get('still-here')?.state).toBe('deleted');
    // No phantom: nothing is keyed by the vanished base key.
    expect(diff.byKey.has('gone')).toBe(false);
    expect(diff.appliedKeyAliases).toEqual(new Map());
  });

  it('an alias for a head key that is not in this revision changes nothing', () => {
    const base = [fp('old', { dataHash: 'd1' })];
    const head = [fp('other', { dataHash: 'd1' })];

    const diff = diffModels(base, head, { keyAliases: new Map([['absent', 'old']]) });
    expect(diff.counts).toEqual({ added: 1, modified: 0, deleted: 1, unchanged: 0 });
    expect(diff.appliedKeyAliases).toEqual(new Map());
  });

  it('two head entities claiming one base key: the alias loses, both stay unaliased', () => {
    const base = [fp('old', { dataHash: 'd1' })];
    const head = [fp('new-1', { dataHash: 'd1' }), fp('new-2', { dataHash: 'd1' })];

    const diff = diffModels(base, head, {
      keyAliases: new Map([
        ['new-1', 'old'],
        ['new-2', 'old'],
      ]),
    });

    // Nothing is silently dropped: both head entities are still visible.
    expect(diff.counts).toEqual({ added: 2, modified: 0, deleted: 1, unchanged: 0 });
    expect(diff.byKey.get('new-1')?.state).toBe('added');
    expect(diff.byKey.get('new-2')?.state).toBe('added');
    expect(diff.byKey.get('old')?.state).toBe('deleted');
    expect(diff.entries).toHaveLength(3);
    expect(diff.appliedKeyAliases).toEqual(new Map());
  });

  it('an alias onto a key another live head entity already holds is refused', () => {
    // `keep` matches base `keep` on its own evidence; the alias would put two
    // head entities on it.
    const base = [fp('keep', { dataHash: 'd1' })];
    const head = [fp('keep', { dataHash: 'd1' }), fp('new', { dataHash: 'd1' })];

    const diff = diffModels(base, head, { keyAliases: new Map([['new', 'keep']]) });

    expect(diff.counts).toEqual({ added: 1, modified: 0, deleted: 0, unchanged: 1 });
    expect(diff.byKey.get('keep')?.state).toBe('unchanged');
    expect(diff.byKey.get('keep')?.head?.key).toBe('keep');
    expect(diff.byKey.get('new')?.state).toBe('added');
    expect(diff.appliedKeyAliases).toEqual(new Map());
  });

  it('a rejected alias does not take a valid one down with it', () => {
    const base = [fp('old-a', { dataHash: 'd1' }), fp('old-b', { dataHash: 'd2' })];
    const head = [
      fp('new-a', { dataHash: 'd1' }),
      fp('new-b1', { dataHash: 'd2' }),
      fp('new-b2', { dataHash: 'd2' }),
    ];

    const diff = diffModels(base, head, {
      keyAliases: new Map([
        ['new-a', 'old-a'],
        ['new-b1', 'old-b'],
        ['new-b2', 'old-b'],
      ]),
    });

    expect(diff.appliedKeyAliases).toEqual(new Map([['new-a', 'old-a']]));
    expect(diff.byKey.get('old-a')?.state).toBe('unchanged');
    expect(diff.counts).toEqual({ added: 2, modified: 0, deleted: 1, unchanged: 1 });
  });

  it('a self-alias is a no-op, not a collision with itself', () => {
    const base = [fp('a', { dataHash: 'd1' })];
    const head = [fp('a', { dataHash: 'd1' })];
    const diff = diffModels(base, head, { keyAliases: new Map([['a', 'a']]) });
    expect(diff.counts).toEqual({ added: 0, modified: 0, deleted: 0, unchanged: 1 });
    expect(diff.appliedKeyAliases).toEqual(new Map());
  });

  it('survives a non-string target from an untyped caller', () => {
    const base = [fp('old', { dataHash: 'd1' })];
    const head = [fp('new', { dataHash: 'd1' })];
    const hostile = new Map<string, string>([['new', 'old']]);
    hostile.set('new', undefined as unknown as string);

    const diff = diffModels(base, head, { keyAliases: hostile });
    expect(diff.counts).toEqual({ added: 1, modified: 0, deleted: 1, unchanged: 0 });
    expect(diff.appliedKeyAliases).toEqual(new Map());
  });

  it('chained aliases (a→b while b→c) refuse the one that lands on a live head key', () => {
    // `b` is a live head key, so `a → b` is refused (rule 3) even though `b`
    // would itself have moved on. Conservative on purpose: the fallback is
    // guaranteed collision-free in one pass instead of cascading.
    const base = [fp('b', { dataHash: 'd1' }), fp('c', { dataHash: 'd1' })];
    const head = [fp('a', { dataHash: 'd1' }), fp('b', { dataHash: 'd1' })];

    const diff = diffModels(base, head, {
      keyAliases: new Map([
        ['a', 'b'],
        ['b', 'c'],
      ]),
    });

    expect(diff.appliedKeyAliases).toEqual(new Map([['b', 'c']]));
    expect(diff.byKey.get('c')?.state).toBe('unchanged');
    expect(diff.byKey.get('a')?.state).toBe('added');
    expect(diff.byKey.get('b')?.state).toBe('deleted');
  });
});

describe('diffModels — keyAliases: composition', () => {
  it('composes with excludeTypes: an aliased pair of an excluded class disappears', () => {
    const base = [
      fp('old-opening', { ifcType: 'IfcOpeningElement', dataHash: 'd1' }),
      fp('old-wall', { dataHash: 'd2' }),
    ];
    const head = [
      fp('new-opening', { ifcType: 'IfcOpeningElement', dataHash: 'd1' }),
      fp('new-wall', { dataHash: 'd2' }),
    ];

    const diff = diffModels(base, head, {
      excludeTypes: ['IfcOpeningElement'],
      keyAliases: new Map([
        ['new-opening', 'old-opening'],
        ['new-wall', 'old-wall'],
      ]),
    });

    expect(diff.excludedTypes).toEqual(['IFCOPENINGELEMENT']);
    expect(diff.entries).toHaveLength(1);
    expect(diff.byKey.get('old-wall')?.state).toBe('unchanged');
    // Both aliases applied — exclusion happens after matching, so the alias
    // itself is untouched by it.
    expect(diff.appliedKeyAliases?.size).toBe(2);
  });

  it('an alias of a NON-excluded class onto an excluded base key drops the pair', () => {
    // Once the two are declared one entity, `excludeTypes`'s union rule ("drop
    // if EITHER revision's class is excluded") applies to them as a pair.
    const base = [fp('old', { ifcType: 'IfcOpeningElement', dataHash: 'd1' })];
    const head = [fp('new', { ifcType: 'IfcWall', dataHash: 'd1' })];

    const diff = diffModels(base, head, {
      excludeTypes: ['IfcOpeningElement'],
      keyAliases: new Map([['new', 'old']]),
    });

    expect(diff.entries).toEqual([]);
    expect(diff.counts).toEqual({ added: 0, modified: 0, deleted: 0, unchanged: 0 });
  });

  it('composes with scope: data', () => {
    const base = [fp('old', { dataHash: 'd1', geometryHash: 1n })];
    const head = [fp('new', { dataHash: 'd1', geometryHash: 2n })];

    const diff = diffModels(base, head, {
      scope: 'data',
      keyAliases: new Map([['new', 'old']]),
    });
    expect(diff.byKey.get('old')?.state).toBe('unchanged');
    expect(diff.byKey.get('old')?.changeKinds).toEqual([]);
  });

  it('composes with scope: geometry', () => {
    const base = [fp('old', { dataHash: 'd1', geometryHash: 1n })];
    const head = [fp('new', { dataHash: 'd2', geometryHash: 2n })];

    const diff = diffModels(base, head, {
      scope: 'geometry',
      keyAliases: new Map([['new', 'old']]),
    });
    expect(diff.byKey.get('old')?.state).toBe('modified');
    expect(diff.byKey.get('old')?.changeKinds).toEqual(['geometry']);
  });

  it('composes with scope: both', () => {
    const base = [fp('old', { dataHash: 'd1', geometryHash: 1n })];
    const head = [fp('new', { dataHash: 'd2', geometryHash: 2n })];

    const diff = diffModels(base, head, {
      scope: 'both',
      keyAliases: new Map([['new', 'old']]),
    });
    expect(diff.byKey.get('old')?.changeKinds).toEqual(['data', 'geometry']);
  });
});

describe('diffModels — keyAliases: the round trip that closes #1891', () => {
  it('a claim accepted in run 1 keeps the element out of the change set in run 2', () => {
    const base = [
      fp('old-a', { dataHash: 'd1', geometryHash: 1n }),
      fp('old-b', { dataHash: 'd2', geometryHash: 2n }),
    ];
    const head = [
      fp('new-a', { dataHash: 'd1', geometryHash: 1n }),
      fp('new-b', { dataHash: 'd2', geometryHash: 2n }),
    ];

    // Run 1: content matching finds the re-GUID and reports it.
    const first = diffModels(base, head, { matchUnpairedByContent: true });
    expect(first.contentMatches).toHaveLength(2);

    // Run 2: the accepted claims replayed as aliases. Nothing to re-derive.
    const aliases = new Map(
      (first.contentMatches ?? [])
        .filter((m) => m.kind === 'renamed' && m.base.length === 1 && m.head.length === 1)
        .map((m) => [m.head[0].key, m.base[0].key] as const),
    );
    const second = diffModels(base, head, { matchUnpairedByContent: true, keyAliases: aliases });

    expect(second.counts).toEqual({ added: 0, modified: 0, deleted: 0, unchanged: 2 });
    expect(second.contentMatches).toEqual([]);
  });
});
