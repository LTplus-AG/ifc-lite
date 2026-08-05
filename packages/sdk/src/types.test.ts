/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `EntityRef` ⇄ `EntityRefString` codec.
 *
 * Both functions are exported from the package root and documented as
 * the transport encoding external tools use — and neither had a single
 * test in this package: swapping the two halves of `entityRefToString`,
 * or dropping the empty-modelId and negative-expressId guards in
 * `stringToEntityRef`, left the whole SDK suite green. (`apps/viewer`
 * has a same-named pair under `src/store/types.ts`; that is the
 * viewer's own copy and does not exercise this one.)
 */

import { describe, expect, it } from 'vitest';
import { entityRefToString, stringToEntityRef } from './types.js';
import type { EntityRef } from './types.js';

describe('entityRefToString', () => {
  it('emits modelId first and expressId second', () => {
    expect(entityRefToString({ modelId: 'arch', expressId: 42 })).toBe('arch:42');
  });

  it('is not symmetric — a numeric-looking modelId still comes first', () => {
    // Pins the field order independently of the round-trip test below,
    // which a swapped implementation would still satisfy.
    expect(entityRefToString({ modelId: '7', expressId: 42 })).toBe('7:42');
  });

  it('encodes expressId 0', () => {
    expect(entityRefToString({ modelId: 'm', expressId: 0 })).toBe('m:0');
  });
});

describe('stringToEntityRef', () => {
  it('decodes a plain reference', () => {
    expect(stringToEntityRef('arch:42')).toEqual({ modelId: 'arch', expressId: 42 });
  });

  it('accepts expressId 0', () => {
    expect(stringToEntityRef('m:0')).toEqual({ modelId: 'm', expressId: 0 });
  });

  // `idx < 1` (not `idx < 0`): a leading colon means an empty modelId,
  // which is not a usable reference in a federated model set. Relaxing
  // the guard produced `{ modelId: '', expressId: 42 }` silently.
  it('rejects an empty modelId', () => {
    expect(() => stringToEntityRef(':42')).toThrow(/Invalid EntityRefString/);
  });

  it('rejects a string with no separator', () => {
    expect(() => stringToEntityRef('arch')).toThrow(/Invalid EntityRefString/);
  });

  it('rejects the empty string', () => {
    expect(() => stringToEntityRef('')).toThrow(/Invalid EntityRefString/);
  });

  it('rejects a non-numeric expressId', () => {
    expect(() => stringToEntityRef('arch:abc')).toThrow(/Invalid expressId/);
  });

  // The `expressId < 0` half of the guard: express IDs are STEP line
  // numbers and are never negative. Without it "arch:-1" decoded to a
  // ref no backend can resolve.
  it('rejects a negative expressId', () => {
    expect(() => stringToEntityRef('arch:-1')).toThrow(/Invalid expressId/);
  });

  it('rejects a non-finite expressId', () => {
    expect(() => stringToEntityRef('arch:Infinity')).toThrow(/Invalid expressId/);
    expect(() => stringToEntityRef('arch:NaN')).toThrow(/Invalid expressId/);
  });
});

describe('EntityRef round trip', () => {
  it.each<EntityRef>([
    { modelId: 'arch', expressId: 42 },
    { modelId: 'm', expressId: 0 },
    { modelId: '7', expressId: 9 },
  ])('round-trips %o', (ref) => {
    expect(stringToEntityRef(entityRefToString(ref))).toEqual(ref);
  });
});
