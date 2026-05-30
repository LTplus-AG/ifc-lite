/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * BIM discipline definitions, IFC type mappings, and clash rule presets.
 * Inspired by industry-standard discipline coordination workflows.
 */

import { matchesSelector } from './selectors.js';
import type { ClashMode, ClashRule, ClashSeverity } from './types.js';

export type Discipline = 'ARCH' | 'STR' | 'MEP' | 'HVAC' | 'ELEC' | 'FIRE' | 'GEO';

export interface DisciplineInfo {
  code: Discipline;
  label: string;
  selector: string;
}

export const DISCIPLINES: Record<Discipline, DisciplineInfo> = {
  ARCH: {
    code: 'ARCH',
    label: 'Architectural',
    selector: 'IfcWall|IfcSlab|IfcRoof|IfcStair|IfcDoor|IfcWindow|IfcCurtainWall|IfcRailing',
  },
  STR: {
    code: 'STR',
    label: 'Structural',
    selector: 'IfcBeam|IfcColumn|IfcSlab|IfcFooting|IfcPile|IfcWall',
  },
  MEP: {
    code: 'MEP',
    label: 'Mechanical / Plumbing',
    selector: 'IfcPipe*|IfcPump|IfcValve*|IfcTank|IfcFlowTerminal',
  },
  HVAC: {
    code: 'HVAC',
    label: 'HVAC',
    selector: 'IfcDuct*|IfcAirTerminal*|IfcUnitaryEquipment|IfcFan',
  },
  ELEC: {
    code: 'ELEC',
    label: 'Electrical',
    selector: 'IfcCableSegment|IfcCableFitting|IfcCableCarrierSegment|IfcElectricDistributionBoard|IfcJunctionBox',
  },
  FIRE: {
    code: 'FIRE',
    label: 'Fire Protection',
    selector: 'IfcFireSuppressionTerminal|IfcPipe*',
  },
  GEO: {
    code: 'GEO',
    label: 'Site / Geotechnical',
    selector: 'IfcSite|IfcGeographicElement|IfcEarthworksElement',
  },
};

export interface ClashRulePreset {
  id: string;
  name: string;
  description: string;
  severity: ClashSeverity;
  selectorA: string;
  selectorB: string;
}

export const CLASH_RULE_PRESETS: ClashRulePreset[] = [
  {
    id: 'MEPxSTR',
    name: 'MEP vs Structure',
    description: 'Pipes and fittings clashing with beams, columns, and slabs',
    severity: 'critical',
    selectorA: 'IfcPipe*|IfcPump|IfcValve*|IfcTank',
    selectorB: 'IfcBeam|IfcColumn|IfcSlab|IfcFooting',
  },
  {
    id: 'HVACxSTR',
    name: 'HVAC vs Structure',
    description: 'Ducts clashing with structural elements',
    severity: 'critical',
    selectorA: 'IfcDuct*|IfcAirTerminal*|IfcUnitaryEquipment',
    selectorB: 'IfcBeam|IfcColumn|IfcSlab',
  },
  {
    id: 'HVACxARCH',
    name: 'HVAC vs Architecture',
    description: 'Ducts passing through walls and slabs (penetration sleeves needed)',
    severity: 'major',
    selectorA: 'IfcDuct*|IfcAirTerminal*',
    selectorB: 'IfcWall|IfcSlab|IfcRoof',
  },
  {
    id: 'MEPxARCH',
    name: 'MEP vs Architecture',
    description: 'Pipes passing through walls and slabs (penetration sleeves needed)',
    severity: 'major',
    selectorA: 'IfcPipe*|IfcPump|IfcValve*',
    selectorB: 'IfcWall|IfcSlab|IfcRoof',
  },
  {
    id: 'HVACxMEP',
    name: 'HVAC vs MEP',
    description: 'Ducts crossing pipes (routing conflicts)',
    severity: 'major',
    selectorA: 'IfcDuct*',
    selectorB: 'IfcPipe*',
  },
  {
    id: 'FIRExSTR',
    name: 'Fire Protection vs Structure',
    description: 'Sprinkler pipes clashing with structure',
    severity: 'critical',
    selectorA: 'IfcFireSuppressionTerminal|IfcPipe*',
    selectorB: 'IfcBeam|IfcColumn|IfcSlab',
  },
  {
    id: 'ELECxMEP',
    name: 'Electrical vs MEP',
    description: 'Cables too close to pipes (separation rules)',
    severity: 'minor',
    selectorA: 'IfcCableSegment|IfcCableFitting|IfcCableCarrierSegment',
    selectorB: 'IfcPipe*|IfcDuct*',
  },
];

const SEVERITY_ORDER: Record<ClashSeverity, number> = {
  critical: 0,
  major: 1,
  minor: 2,
  info: 3,
};

/**
 * Infer severity for a clash from the IFC types of the two elements, by matching
 * against the discipline-pair presets. Returns the most severe matching rule.
 */
export function inferClashSeverity(typeA: string, typeB: string): ClashSeverity {
  let best: ClashSeverity = 'info';

  for (const preset of CLASH_RULE_PRESETS) {
    const matchForward =
      matchesSelector(typeA, preset.selectorA) && matchesSelector(typeB, preset.selectorB);
    const matchReverse =
      matchesSelector(typeA, preset.selectorB) && matchesSelector(typeB, preset.selectorA);

    if ((matchForward || matchReverse) && SEVERITY_ORDER[preset.severity] < SEVERITY_ORDER[best]) {
      best = preset.severity;
    }
  }

  return best;
}

/** Turn the discipline presets into runnable clash rules (the clash matrix). */
/**
 * Turn an arbitrary list of rule presets into runnable `ClashRule`s. Used by the
 * built-in discipline matrix below and by the viewer to run a user-edited preset
 * set. `clearance` is threaded onto each rule only in clearance mode (narrow.ts
 * only reports clearance violations when `rule.clearance != null`); `reportTouch`
 * is threaded onto every rule when set.
 */
export function rulesFromPresets(
  presets: ClashRulePreset[],
  mode: ClashMode = 'hard',
  clearance?: number,
  reportTouch?: boolean,
): ClashRule[] {
  return presets.map((preset) => ({
    id: preset.id,
    name: preset.name,
    a: preset.selectorA,
    b: preset.selectorB,
    mode,
    severity: preset.severity,
    ...(mode === 'clearance' && clearance != null ? { clearance } : {}),
    ...(reportTouch ? { reportTouch: true } : {}),
  }));
}

export function disciplineMatrixRules(mode: ClashMode = 'hard', clearance?: number): ClashRule[] {
  return rulesFromPresets(CLASH_RULE_PRESETS, mode, clearance);
}
