/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import {
  CLASH_RULE_PRESETS,
  disciplineMatrixRules,
  inferClashSeverity,
} from './disciplines.js';

describe('inferClashSeverity', () => {
  it('rates MEP vs Structure as critical (either order)', () => {
    expect(inferClashSeverity('IfcPipeSegment', 'IfcBeam')).toBe('critical');
    expect(inferClashSeverity('IfcBeam', 'IfcPipeSegment')).toBe('critical');
  });

  it('rates Electrical vs MEP as minor', () => {
    expect(inferClashSeverity('IfcCableSegment', 'IfcPipeSegment')).toBe('minor');
  });

  it('falls back to info for unknown pairs', () => {
    expect(inferClashSeverity('IfcFurniture', 'IfcFurniture')).toBe('info');
  });
});

describe('disciplineMatrixRules', () => {
  it('produces one runnable rule per preset', () => {
    const rules = disciplineMatrixRules('hard');
    expect(rules).toHaveLength(CLASH_RULE_PRESETS.length);
    for (const rule of rules) {
      expect(rule.mode).toBe('hard');
      expect(rule.a.length).toBeGreaterThan(0);
      expect(rule.b && rule.b.length).toBeGreaterThan(0);
    }
  });
});
