/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import {
  CLASH_RULE_PRESETS,
  disciplineMatrixRules,
  rulesFromPresets,
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

  it('never sets clearance in hard mode, even if a value is passed', () => {
    const rules = disciplineMatrixRules('hard', 0.05);
    for (const rule of rules) {
      expect(rule.clearance).toBeUndefined();
    }
  });

  it('threads a clearance value onto every rule in clearance mode', () => {
    // Regression: a clearance matrix reports nothing unless each rule carries a
    // `clearance` (narrow.ts gates clearance violations on `rule.clearance != null`).
    const rules = disciplineMatrixRules('clearance', 0.05);
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      expect(rule.mode).toBe('clearance');
      expect(rule.clearance).toBe(0.05);
    }
  });

  it('omits clearance in clearance mode when no value is provided', () => {
    const rules = disciplineMatrixRules('clearance');
    for (const rule of rules) {
      expect(rule.clearance).toBeUndefined();
    }
  });

  it('is exactly rulesFromPresets over the built-in list (CLI/MCP/SDK contract)', () => {
    expect(disciplineMatrixRules('hard')).toEqual(rulesFromPresets(CLASH_RULE_PRESETS, 'hard'));
    expect(disciplineMatrixRules('clearance', 0.05)).toEqual(
      rulesFromPresets(CLASH_RULE_PRESETS, 'clearance', 0.05),
    );
  });
});

describe('rulesFromPresets', () => {
  const custom = [{ id: 'x', name: 'X', description: '', severity: 'major' as const, selectorA: 'IfcDuct*', selectorB: 'IfcDuct*' }];

  it('maps each preset to a runnable rule', () => {
    const rules = rulesFromPresets(custom, 'hard');
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ id: 'x', a: 'IfcDuct*', b: 'IfcDuct*', mode: 'hard', severity: 'major' });
  });

  it('threads clearance (clearance mode only) and reportTouch onto every rule', () => {
    expect(rulesFromPresets(custom, 'clearance', 0.1)[0].clearance).toBe(0.1);
    expect(rulesFromPresets(custom, 'hard', 0.1)[0].clearance).toBeUndefined();
    expect(rulesFromPresets(custom, 'hard', undefined, true)[0].reportTouch).toBe(true);
  });
});
