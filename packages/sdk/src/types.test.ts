/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { entityRefToString, stringToEntityRef } from './types.js';

describe('entityRefToString / stringToEntityRef', () => {
  it('round-trips a simple ref', () => {
    const ref = { modelId: 'arch', expressId: 42 };
    expect(stringToEntityRef(entityRefToString(ref))).toEqual(ref);
  });

  it('rejects a string with an empty expressId ("modelId:" with nothing after)', () => {
    // A truncated/corrupted ref must not silently decode to expressId 0 —
    // Number('') is 0, which previously slipped past the Number.isFinite check.
    expect(() => stringToEntityRef('arch:')).toThrow();
  });

  it('rejects a non-numeric expressId', () => {
    expect(() => stringToEntityRef('arch:abc')).toThrow();
  });

  it('round-trips a modelId that itself contains a colon', () => {
    const ref = { modelId: 'proj:arch', expressId: 5 };
    const encoded = entityRefToString(ref);
    // Pin against a literal so a bug shared between encode and decode can't cancel out.
    expect(encoded).toBe('proj:arch:5');
    expect(stringToEntityRef(encoded)).toEqual(ref);
  });
});
