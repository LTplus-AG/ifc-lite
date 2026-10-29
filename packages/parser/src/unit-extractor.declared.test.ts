/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { declareLengthUnitScale, extractLengthUnitScale, resolveLengthUnit } from './unit-extractor.js';

const index = () => ({ byId: new Map(), byType: new Map<string, number[]>() });
const source = new Uint8Array(0);

describe('a declared length unit scale (IFCX has no IfcProject to read it from)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('is answered with no unit warning and no diagnostic, still as the unconfirmed default it is', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const declared = index();
    declareLengthUnitScale(declared, 0.001);
    expect(extractLengthUnitScale(source, declared)).toBe(0.001);
    expect(warn).not.toHaveBeenCalled();
    const onDiagnostic = vi.fn();
    expect(resolveLengthUnit(source, declared, undefined, onDiagnostic)).toEqual({ scale: 0.001, source: 'default' });
    expect(onDiagnostic).not.toHaveBeenCalled();
  });

  it('is per model: another model without a project still falls back and warns', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    declareLengthUnitScale(index(), 0.001);
    expect(extractLengthUnitScale(source, index())).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('ignores a scale that is not a positive number', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const declared = index();
    declareLengthUnitScale(declared, 0);
    declareLengthUnitScale(declared, Number.NaN);
    expect(extractLengthUnitScale(source, declared)).toBe(1);
  });
});
