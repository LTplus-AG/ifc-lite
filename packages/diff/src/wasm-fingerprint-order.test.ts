/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// #8114: the oracle raises an engine string-length RangeError while sorting or
// hashing one collection, before it reads the next field. The facade must ask
// Rust at that point, on its fresh projection, and only for sparse input.
import { existsSync, readFileSync } from 'node:fs';
import { expect, test, vi } from 'vitest';
import * as oracle from '../test/oracle/fingerprint.js';
import type { DataFingerprintInput } from './fingerprint.js';

// The real export runs and returns its own result; only its position is
// recorded. Adapter getters record into both lists.
const trace = vi.hoisted(() => [] as string[]);
const reads: string[] = [];
vi.mock('@ifc-lite/wasm/diff', async importOriginal => {
  const actual = await importOriginal<typeof import('@ifc-lite/wasm/diff')>();
  return {
    ...actual,
    diffCheckFingerprintCollections(collection: object, components: boolean) {
      trace.push(`check:${Object.keys(collection).join()}`);
      return actual.diffCheckFingerprintCollections(collection, components);
    },
  };
});

const binary = new URL('../../wasm/pkg-diff/ifc-lite-diff_bg.wasm', import.meta.url);
const glue = new URL('../../wasm/pkg-diff/ifc-lite-diff.js', import.meta.url);
type Implementation = Pick<typeof oracle, 'buildDataFingerprint' | 'buildComponentFingerprints'>;
const operations = ['buildDataFingerprint', 'buildComponentFingerprints'] as const;

function watched(fields: Record<string, unknown>): DataFingerprintInput {
  const input = {};
  // Annotated: inferred from the spread, Object.entries would type every value as string.
  const values: Record<string, unknown> = { ifcType: 'IfcWall', ...fields };
  for (const [key, value] of Object.entries(values)) {
    Object.defineProperty(input, key, { enumerable: true, get() {
      trace.push(`get:${key}`);
      reads.push(`get:${key}`);
      if (value instanceof Error) throw value;
      return value;
    } });
  }
  return input as DataFingerprintInput;
}
function observe(implementation: Implementation, operation: typeof operations[number], fields: Record<string, unknown>) {
  trace.length = 0;
  reads.length = 0;
  let outcome: unknown;
  try {
    const value = implementation[operation](watched(fields));
    outcome = typeof value === 'object' ? Object.entries(value) : value;
  } catch (error) {
    outcome = error instanceof Error ? [error.constructor.name, error.message] : error;
  }
  return { outcome, reads: reads.splice(0), trace: trace.splice(0) };
}

const entry = { name: 'E', value: '\ud800' };
const later = new RangeError('later field');
const cases: Record<string, Record<string, unknown>> = {
  dense: { propertySets: [{ name: 'P', properties: [entry] }], quantitySets: [{ name: 'Q', quantities: [entry] }],
    typeAssignments: [{ name: 'T', type: 'IfcWallType' }], materials: ['M'] },
  // Literal holes are the sparse inputs under test (#8114).
  // eslint-disable-next-line no-sparse-arrays
  outerSetHole: { propertySets: [, { name: 'P', properties: [] }], quantitySets: later },
  // A literal trailing member hole is the nested sparse input under test (#8114).
  // eslint-disable-next-line no-sparse-arrays
  memberHole: { propertySets: [{ name: 'P', properties: [entry, ,] }], quantitySets: later },
  tiebreakHoles: { propertySets: [{ name: 'D', properties: new Array(3) }, { name: 'D', properties: [entry] }],
    quantitySets: [{ name: 'Q', quantities: new Array(2) }], typeAssignments: later },
  typeHoles: { typeAssignments: new Array(2), materials: later },
};
// Exactly where the facade asks Rust: after the sparse collection's own read,
// before the next field and before the components outer-hole TypeError.
const checks: Record<string, Record<typeof operations[number], string[]>> = {
  dense: {
    buildDataFingerprint: ['get:propertySets', 'get:quantitySets', 'get:typeAssignments', 'get:materials', 'get:ifcType'],
    buildComponentFingerprints: ['get:ifcType', 'get:propertySets', 'get:quantitySets', 'get:typeAssignments', 'get:materials'],
  },
  outerSetHole: {
    buildDataFingerprint: ['get:propertySets', 'check:propertySets', 'get:quantitySets'],
    buildComponentFingerprints: ['get:ifcType', 'get:propertySets', 'check:propertySets'],
  },
  memberHole: {
    buildDataFingerprint: ['get:propertySets', 'check:propertySets', 'get:quantitySets'],
    buildComponentFingerprints: ['get:ifcType', 'get:propertySets', 'check:propertySets', 'get:quantitySets'],
  },
  tiebreakHoles: {
    buildDataFingerprint: ['get:propertySets', 'check:propertySets', 'get:quantitySets', 'check:quantitySets', 'get:typeAssignments'],
    buildComponentFingerprints: ['get:ifcType', 'get:propertySets', 'check:propertySets', 'get:quantitySets',
      'check:quantitySets', 'get:typeAssignments'],
  },
  // Data mode builds no type-assignment text before the final one: no call.
  typeHoles: {
    buildDataFingerprint: ['get:typeAssignments', 'get:materials'],
    buildComponentFingerprints: ['get:ifcType', 'get:typeAssignments', 'check:typeAssignments', 'get:materials'],
  },
};

test.skipIf(!existsSync(binary) || !existsSync(glue))('sparse collections are length-checked in oracle order, dense input never (#8114)', async () => {
  const { initDiffSync } = await import('./wasm-runtime.js');
  initDiffSync({ module: readFileSync(binary) });
  const facade = await import('./wasm-fingerprint.js');
  for (const [name, fields] of Object.entries(cases)) {
    for (const operation of operations) {
      const actual = observe(facade, operation, fields);
      const expected = observe(oracle, operation, fields);
      expect(actual.outcome, `${name}/${operation}`).toEqual(expected.outcome);
      expect(actual.reads, `${name}/${operation}: adapter reads`).toEqual(expected.reads);
      expect(actual.trace, `${name}/${operation}: check position`).toEqual(checks[name][operation]);
    }
  }
  // A reentrant facade call inside an adapter getter checks its own sparse
  // collection without consuming or resetting the outer call's state: the
  // first set has already marked the outer collection sparse when the second
  // set's name getter reenters, so a shared flag would lose the outer check.
  for (const operation of operations) {
    const run = (implementation: Implementation) => observe(implementation, operation, {
      propertySets: [{ name: 'A', properties: new Array(2) }, {
        get name() { return implementation.buildDataFingerprint({ ifcType: 'Inner', propertySets: [{ name: 'I', properties: new Array(1) }] }); },
        properties: [] }],
    });
    const actual = run(facade);
    expect(actual.outcome).toEqual(run(oracle).outcome);
    expect(actual.trace).toEqual([...operation === 'buildDataFingerprint' ? [] : ['get:ifcType'], 'get:propertySets',
      'check:propertySets', 'check:propertySets', ...operation === 'buildDataFingerprint' ? ['get:ifcType'] : []]);
  }
});

// A one-shot lazy iterable with its own map, as an iterator helper or a
// generator's map returns: it calls back only while walked, has no length and
// is empty once walked. Hand-written so no Iterator helper is required.
function lazy<T>(values: T[]) {
  return {
    map<U>(one: (value: T) => U) {
      let index = 0;
      const iterator = {
        [Symbol.iterator]() { return iterator; },
        next(): IteratorResult<U> {
          return index < values.length ? { done: false, value: one(values[index++]) } : { done: true, value: undefined };
        },
      };
      return iterator;
    },
  };
}
// Where a lazily mapped collection reaches the final decode as its only
// consumer. Component outer sets are excluded: the outer-hole for-of already
// consumes them, which is an existing mismatch this does not change.
const iterables: [string, typeof operations[number][], (make: <T>(values: T[]) => unknown) => Record<string, unknown>][] = [
  ['properties', [...operations], make => ({ propertySets: [{ name: 'P', properties: make([entry, { name: 'F', value: 2 }]) }] })],
  ['quantities', [...operations], make => ({ quantitySets: [{ name: 'Q', quantities: make([entry]) }] })],
  ['typeAssignments', [...operations], make => ({ typeAssignments: make([{ name: 'T', type: 'IfcWallType' }, { name: 'U' }]) })],
  ['propertySets', ['buildDataFingerprint'], make => ({ propertySets: make([{ name: 'P', properties: [entry] }]) })],
  ['quantitySets', ['buildDataFingerprint'], make => ({ quantitySets: make([{ name: 'Q', quantities: [entry] }]) })],
];

test.skipIf(!existsSync(binary) || !existsSync(glue))('lazily mapped collections are never checked and keep their content (#8114)', async () => {
  const { initDiffSync } = await import('./wasm-runtime.js');
  initDiffSync({ module: readFileSync(binary) });
  const facade = await import('./wasm-fingerprint.js');
  for (const [location, modes, fields] of iterables) {
    for (const operation of modes) {
      const actual = observe(facade, operation, fields(lazy));
      // The TS oracle sorts, so it rejects an iterator; its dense hash is the reference.
      const dense = observe(oracle, operation, fields(values => values));
      expect(actual.outcome, `${location}/${operation}: content survives`).toEqual(dense.outcome);
      expect(actual.trace, `${location}/${operation}: no collection check`).toEqual(actual.reads);
    }
  }
});
