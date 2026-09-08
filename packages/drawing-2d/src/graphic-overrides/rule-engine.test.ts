/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { createOverrideEngine, ifcTypeCriterion } from './rule-engine.js';
import type { GraphicOverrideRule, ElementData } from './types.js';

/**
 * A rule keyed on `supertype` with the default `includeSubtypes`, i.e. exactly
 * what `ifcTypeCriterion(['IfcBuildingElement'])` gives a user who writes a
 * rule against a supertype.
 */
function supertypeRule(supertype: string): GraphicOverrideRule {
  return {
    id: `rule-${supertype}`,
    name: `override ${supertype}`,
    enabled: true,
    priority: 0,
    criteria: ifcTypeCriterion([supertype]),
    style: { fillColor: '#FF0000' },
  };
}

function element(ifcType: string): ElementData {
  return { expressId: 1, ifcType };
}

/** Does a rule on `supertype` actually reach an element of `ifcType`? */
function overrideReaches(supertype: string, ifcType: string): boolean {
  const engine = createOverrideEngine([supertypeRule(supertype)]);
  const result = engine.applyOverrides(element(ifcType));
  return result.matchedRules.length > 0;
}

describe('graphic-override subtype matching', () => {
  it('reaches an element named directly by the rule (anti-vacuity control)', () => {
    // If this ever fails the helper is broken and every expectation below is vacuous.
    expect(overrideReaches('IfcWall', 'IfcWall')).toBe(true);
  });

  it('does NOT reach an element outside the rule subtree (negative control)', () => {
    // IfcSpace is IfcSpatialElement, not IfcBuildingElement — a rule on
    // IfcBuildingElement must not style it, or the matcher is matching everything.
    expect(overrideReaches('IfcBuildingElement', 'IfcSpace')).toBe(false);
    expect(overrideReaches('IfcWall', 'IfcSlab')).toBe(false);
  });

  describe('IfcBuildingElement', () => {
    // Named, not counted: a magic floor reds on benign schema growth and stays
    // silent on exactly the regression that matters — a name dropping out.
    const REQUIRED = [
      'IfcWall',
      'IfcWallStandardCase',
      'IfcSlab',
      'IfcBeam',
      'IfcColumn',
      'IfcDoor',
      'IfcWindow',
      'IfcStair',
      'IfcStairFlight',
      'IfcRamp',
      'IfcRampFlight',
      'IfcRoof',
      'IfcRailing',
      'IfcCovering',
      'IfcCurtainWall',
      'IfcPlate',
      'IfcPlateStandardCase',
      'IfcMember',
      'IfcMemberStandardCase',
      'IfcFooting',
      'IfcPile',
      'IfcBuildingElementProxy',
      'IfcChimney',
      'IfcShadingDevice',
    ];

    it.each(REQUIRED)('a rule on IfcBuildingElement reaches %s', (ifcType) => {
      expect(overrideReaches('IfcBuildingElement', ifcType)).toBe(true);
    });
  });

  describe('IfcDistributionElement', () => {
    const REQUIRED = [
      'IfcDistributionFlowElement',
      'IfcDistributionControlElement',
      'IfcDuctSegment',
      'IfcDuctFitting',
      'IfcPipeSegment',
      'IfcPipeFitting',
      'IfcAirTerminal',
      'IfcCableCarrierSegment',
      'IfcSanitaryTerminal',
      'IfcOutlet',
      'IfcSwitchingDevice',
      'IfcSensor',
      'IfcActuator',
      'IfcAlarm',
      'IfcPump',
      'IfcValve',
    ];

    it.each(REQUIRED)('a rule on IfcDistributionElement reaches %s', (ifcType) => {
      expect(overrideReaches('IfcDistributionElement', ifcType)).toBe(true);
    });
  });

  describe('IfcDistributionFlowElement', () => {
    // The real IFC supertype of the flow entities. The table shipped a
    // non-entity key `IfcFlowElement` in its place, leaving this one unresolved.
    const REQUIRED = [
      'IfcFlowSegment',
      'IfcFlowFitting',
      'IfcFlowTerminal',
      'IfcFlowController',
      'IfcDuctSegment',
      'IfcPipeSegment',
      'IfcAirTerminal',
      'IfcValve',
    ];

    it.each(REQUIRED)('a rule on IfcDistributionFlowElement reaches %s', (ifcType) => {
      expect(overrideReaches('IfcDistributionFlowElement', ifcType)).toBe(true);
    });
  });

  it('reaches leaf flow types through an intermediate supertype', () => {
    expect(overrideReaches('IfcFlowTerminal', 'IfcAirTerminal')).toBe(true);
    expect(overrideReaches('IfcFlowSegment', 'IfcDuctSegment')).toBe(true);
    expect(overrideReaches('IfcElement', 'IfcCurtainWall')).toBe(true);
  });

  it('honours includeSubtypes: false', () => {
    const engine = createOverrideEngine([
      {
        id: 'exact',
        name: 'exact',
        enabled: true,
        priority: 0,
        criteria: ifcTypeCriterion(['IfcBuildingElement'], false),
        style: { fillColor: '#FF0000' },
      },
    ]);
    expect(engine.applyOverrides(element('IfcWall')).matchedRules).toHaveLength(0);
  });
});
