/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { existsSync } from 'node:fs';
import { expect, test } from 'vitest';
import { diffModels } from '../test/oracle/diff.js';
import type { EntityFingerprint } from './types.js';

const binary = new URL('../../wasm/pkg-diff/ifc-lite-diff_bg.wasm', import.meta.url);
test.skipIf(!existsSync(binary))('retained snapshots preserve parity, ref identity, edits and release (#8042; run pnpm build:wasm)', async () => {
  const { initDiff } = await import('./wasm-runtime.js');
  const { prepareDiffModel } = await import('./index.js');
  await initDiff();
  const ref = { opaque: () => 42 };
  const headRef = { opaque: () => 43 };
  const sourceMin: [number, number, number] = [0, 0, 0];
  const base: EntityFingerprint<typeof ref>[] = [{ key: 'old', ifcType: 'IfcWall',
    dataHash: 'a', components: { 'attr:core': 'a' }, ref,
    aabb: { min: sourceMin, max: [1, 1, 1] } }];
  const head: typeof base = [{ ...base[0], key: 'new', ref: headRef, components: { 'attr:core': 'a' },
    aabb: { min: [0, 0, 0], max: [1, 1, 1] } }];
  const left = prepareDiffModel(base.values());
  try {
    const right = prepareDiffModel(head);
    try {
      for (const options of [{}, { matchUnpairedByContent: true },
        { keyAliases: new Map([['new', 'old']]) }, { excludeTypes: ['IfcWall'] }]) {
        const result = left.compare(right, options);
        expect(result).toEqual(diffModels(base, head, options));
        for (const entry of result.entries) {
          expect(result.byKey.get(entry.key)).toBe(entry);
          if (entry.base) expect(entry.base.ref).toBe(ref);
          if (entry.head) expect(entry.head.ref).toBe(headRef);
        }
      }
      const before = left.compare(right);
      base[0].dataHash = 'edited';
      base[0].components!['attr:core'] = 'edited';
      sourceMin[0] = 100;
      expect(left.compare(right)).toEqual(before);
      const fresh = prepareDiffModel(base);
      try { expect(fresh.compare(right)).toEqual(diffModels(base, head)); }
      finally { fresh.dispose(); }
      right[Symbol.dispose]();
      right.dispose();
      expect(() => left.compare(right)).toThrow(/disposed/);
      expect(before.entries[0].base?.dataHash).toBe('a');
    } finally { right.dispose(); }
    left[Symbol.dispose]();
    left[Symbol.dispose]();
    expect(() => left.compare(left)).toThrow(/disposed/);
  } finally { left.dispose(); }
});

test.skipIf(!existsSync(binary))('decoded handle entries are eager, independently mutable records with stable rows (#8042 A3)', async () => {
  const { initDiff } = await import('./wasm-runtime.js');
  const { prepareDiffModel } = await import('./index.js');
  await initDiff();
  const ref = { opaque: Symbol('ref') };
  const row = (key: string, dataHash = 'before'): EntityFingerprint<typeof ref> => ({
    key, ifcType: 'IfcWall', dataHash, components: { '\ud800': dataHash }, ref,
  });
  const base = [row('changed'), row('unchanged'), row('deleted'), row('__proto__')];
  const head = [row('added'), row('unchanged'), row('changed', 'after'), row('alias')];
  const options = { keyAliases: new Map([['alias', '__proto__']]) };
  const left = prepareDiffModel(base), right = prepareDiffModel(head);
  try {
    const expected = diffModels(base, head, options);
    const first = left.compare(right, options), second = left.compare(right, options);
    expect(first).toEqual(expected);
    expect([...first.byKey.keys()]).toEqual([...expected.byKey.keys()]);
    for (let i = 0; i < first.entries.length; i++) {
      const entry = first.entries[i], next = second.entries[i];
      expect(first.byKey.get(entry.key)).toBe(entry);
      expect(entry).not.toBe(next);
      expect(entry.changeKinds).not.toBe(next.changeKinds);
      expect(entry.base).toBe(next.base);
      expect(entry.head).toBe(next.head);
      expect(Object.keys(entry)).toEqual(Object.keys(expected.entries[i]));
      for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(entry))) {
        expect(descriptor).toMatchObject({ enumerable: true, configurable: true, writable: true });
        expect(descriptor.get).toBeUndefined();
      }
      if (entry.base) expect(entry.base.ref).toBe(ref);
      if (entry.head) expect(entry.head.ref).toBe(ref);
      if (entry.changedComponents) {
        expect(entry.changedComponents).not.toBe(next.changedComponents);
        entry.changedComponents.push('caller edit');
      }
      entry.changeKinds.push('container');
      entry.key = 'caller edit';
      delete entry.base;
    }
    first.entries.reverse();
    first.byKey.clear();
    const third = left.compare(right, options);
    expect(second).toEqual(expected);
    expect(third).toEqual(expected);
    for (let i = 0; i < second.entries.length; i++) {
      expect(third.entries[i].base).toBe(second.entries[i].base);
      expect(third.entries[i].head).toBe(second.entries[i].head);
    }
    left.dispose(); right.dispose();
    expect(third).toEqual(expected);
  } finally { left.dispose(); right.dispose(); }
});
