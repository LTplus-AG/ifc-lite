/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { existsSync, readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { diffModels as oracle } from '../test/oracle/diff.js';
import * as oracleProvenance from '../test/oracle/index.js';
import * as publicDiff from './index.js';
import { diffModels, initDiffSync, prepareDiffModel, DiffModelHandle } from './index.js';
import type { DiffOptions, EntityFingerprint } from './types.js';

const binary = new URL('../../wasm/pkg-diff/ifc-lite-diff_bg.wasm', import.meta.url);
const strip = <R>(rows: EntityFingerprint<R>[]) => rows.map(row =>
  typeof row.geometryHash === 'string' && row.geometryHash.startsWith('p:')
    ? { ...row, geometryHash: undefined } : row);
const wire = (value: unknown) => JSON.stringify(value, (_key, item: unknown) =>
  item instanceof Map ? [...item] : typeof item === 'bigint' ? String(item) : item);
type Vector = { name: string; base: EntityFingerprint<number>[]; head: EntityFingerprint<number>[];
  options?: Omit<DiffOptions, 'keyAliases'> & { keyAliases?: [string, string][] }; expected: unknown };

// #8042 A1: reuse each resident pair across options, including placement
// variants of every differential vector, then return to the original mode.
for (const name of ['core', 'content', 'split', 'successor', 'lineage']) {
  const vectors = JSON.parse(readFileSync(new URL(`../../../rust/diff/tests/${name}_vectors.json`, import.meta.url), 'utf8')) as Vector[];
  test.skipIf(!existsSync(binary)).each(vectors)(`public handles: ${name} $name (#8042; missing WASM: pnpm build:wasm)`, vector => {
    initDiffSync({ module: readFileSync(binary) });
    const options: DiffOptions = { ...vector.options,
      ...(vector.options?.keyAliases ? { keyAliases: new Map(vector.options.keyAliases) } : { keyAliases: undefined }) };
    // Real mesh tokens, symmetric placements, and mixed placements+mesh.
    const placement = (rows: typeof vector.base) => rows.map(row => ({ ...row,
      ...(row.geometryHash === undefined ? {} : { geometryHash: `p:${row.geometryHash}` }) }));
    for (const [base, head] of [[vector.base, vector.head],
      [placement(vector.base), placement(vector.head)], [vector.base, placement(vector.head)]]) {
      const left = prepareDiffModel(base), right = prepareDiffModel(head);
      try {
        expect(left).toBeInstanceOf(DiffModelHandle);
        for (const stripPlacementGeometry of [false, true, false]) {
          const opts = { ...options, stripPlacementGeometry };
          const expected = oracle(stripPlacementGeometry ? strip(base) : base,
            stripPlacementGeometry ? strip(head) : head, options);
          const actual = left.compare(right, opts);
          expect(actual, vector.name).toEqual(expected);
          expect(wire(actual), vector.name).toBe(wire(expected));
          expect(wire(diffModels(base, head, opts)), vector.name).toBe(wire(expected));
          if (stripPlacementGeometry) {
            const again = left.compare(right, opts);
            const records = (result: typeof actual) => [
              ...result.entries.flatMap(entry => [entry.base, entry.head]),
              ...(result.contentMatches ?? []).flatMap(match => [...match.base, ...match.head]),
              ...(result.splitMerges ?? []).flatMap(claim => [claim.whole, ...claim.pieces, claim.excluded]),
              ...(result.successors ?? []).flatMap(claim => [claim.base, claim.head]),
            ].filter(row => row !== undefined);
            const firstRows = records(actual), nextRows = records(again);
            expect(nextRows.length).toBe(firstRows.length);
            for (let i = 0; i < firstRows.length; i++) {
              expect(nextRows[i], vector.name).toBe(firstRows[i]);
              expect(Object.isFrozen(firstRows[i]), vector.name).toBe(true);
            }
            expect(publicDiff.identityMapFromContentMatches(actual.contentMatches), vector.name)
              .toEqual(oracleProvenance.identityMapFromContentMatches(expected.contentMatches));
            expect(publicDiff.identityMapFromSuccessors(actual.successors), vector.name)
              .toEqual(oracleProvenance.identityMapFromSuccessors(expected.successors));
            expect(publicDiff.lineageOfDiff(actual), vector.name).toEqual(oracleProvenance.lineageOfDiff(expected));
          }
          if (base === vector.base && !stripPlacementGeometry) {
            expect(JSON.parse(wire(actual)), vector.name).toEqual(vector.expected);
          }
        }
      } finally { left.dispose(); right[Symbol.dispose](); }
    }
  });
}

// #8042: exclusions and duplicate keys must not change the caller's decision
// to strip. p: is case-sensitive; opaque mesh strings and bigint are preserved.
test.skipIf(!existsSync(binary))('placement stripping preserves output records, refs and original snapshots (#8042)', () => {
  initDiffSync({ module: readFileSync(binary) });
  const ref = { opaque: Symbol('ref') };
  const base = ['p:a', 'p:\ud800', 'P:a', 'xp:a', '', 42n].map((geometryHash, index) => ({
    key: String(index), ifcType: 'IfcWall', dataHash: 'd', geometryHash, ref,
  }));
  const head = base.map(row => ({ ...row, geometryHash: 'p:changed' }));
  const left = prepareDiffModel(base), right = prepareDiffModel(head);
  try {
    const before = left.compare(right);
    for (const options of [{}, { scope: 'data' as const }, { scope: 'geometry' as const },
      { excludeTypes: ['IfcWall'] }, { matchUnpairedByContent: true, detectSplitMerge: true, detectSuccessors: true }]) {
      const actual = left.compare(right, { ...options, stripPlacementGeometry: true });
      expect(wire(actual)).toBe(wire(oracle(strip(base), strip(head), options)));
      for (const entry of actual.entries) {
        expect(entry.base?.ref).toBe(ref);
        expect(entry.head?.ref).toBe(ref);
      }
    }
    expect(left.compare(right)).toEqual(before);
    expect(base[0].geometryHash).toBe('p:a');
  } finally { left.dispose(); right.dispose(); }
});

// #8266 review: the stripped view is owned by each handle, not re-created by
// each compare. Only placement rows differ from the original frozen snapshot.
test.skipIf(!existsSync(binary))('stripped handle views freeze and reuse placement rows while preserving other identities (#8266)', () => {
  initDiffSync({ module: readFileSync(binary) });
  const ref = { opaque: Symbol('ref') };
  const rows: EntityFingerprint<typeof ref>[] = [
    { key: 'placement', ifcType: 'IfcSite', dataHash: 'd', geometryHash: 'p:before', ref },
    { key: 'mesh', ifcType: 'IfcWall', dataHash: 'd', geometryHash: 42n, ref },
    { key: 'absent', ifcType: 'IfcSpace', dataHash: 'd', ref },
  ];
  const left = prepareDiffModel(rows), right = prepareDiffModel(rows);
  try {
    const original = left.compare(right);
    const stripped = left.compare(right, { stripPlacementGeometry: true });
    for (const side of ['base', 'head'] as const) {
      const placement = stripped.byKey.get('placement')![side]!;
      expect(placement.geometryHash).toBeUndefined();
      expect(Object.isFrozen(placement)).toBe(true);
      expect(placement.ref).toBe(ref);
      expect(placement).not.toBe(original.byKey.get('placement')![side]);
      for (const key of ['mesh', 'absent']) {
        expect(stripped.byKey.get(key)![side]).toBe(original.byKey.get(key)![side]);
      }
      for (const scope of ['data', 'both', 'geometry'] as const) {
        const again = left.compare(right, { scope, stripPlacementGeometry: true });
        expect(again.byKey.get('placement')![side]).toBe(placement);
      }
      expect(left.compare(right).byKey.get('placement')![side]!.geometryHash).toBe('p:before');
    }
    left.dispose(); right.dispose();
    expect(stripped.byKey.get('placement')!.base!.ref).toBe(ref);
    expect(stripped.byKey.get('placement')!.base!.geometryHash).toBeUndefined();
  } finally { left.dispose(); right.dispose(); }
});
