/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #5193, the consumer side. `extractMapConversion` already refuses-and-warns
// when a component it reads is an overflowing numeric literal (`1.0E400`),
// via `isUnrepresentableNumericValue`. That predicate now also flags a
// malformed literal -- a dropped comma or trailing garbage that
// `parseAttributeValue` (entity-extractor.ts) preserves as a raw string
// rather than truncating -- so the SAME refuse-and-warn path this file
// already had for overflow now also catches the corrupted-token case,
// through the one console.warn call site rather than a new channel.

import { describe, expect, it, vi } from 'vitest';
import { extractMapConversion } from '../src/georef-map-conversion.js';
import type { IfcEntity } from '../src/types.js';

function mapConversionEntity(eastings: unknown): IfcEntity {
  return {
    expressId: 38,
    type: 'IFCMAPCONVERSION',
    attributes: [10, 37, eastings, 4184941.96970872, 0, 0.866025, 0.5, 1],
  };
}

describe('extractMapConversion refuses a malformed eastings token, and warns (#5193)', () => {
  it('refuses (returns null) rather than substituting getNumber-or-0 for a dropped-comma token', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = extractMapConversion(mapConversionEntity('1.52.3'));
      expect(result).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain('Eastings');
    } finally {
      warn.mockRestore();
    }
  });

  it('still refuses and warns for the pre-existing overflow case, unchanged', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = extractMapConversion(mapConversionEntity('1.0E400'));
      expect(result).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('accepts a legal eastings value and does not warn', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = extractMapConversion(mapConversionEntity(545991.679663973));
      expect(result?.eastings).toBeCloseTo(545991.679663973, 6);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
