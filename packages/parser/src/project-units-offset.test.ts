/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { extractProjectUnits } from './project-units.js';
import { scaleMeasureValue } from './measure-unit-scale.js';
import type { EntityIndex, EntityRef } from './types.js';

/**
 * `IfcConversionBasedUnitWithOffset` (#7395): a degree Fahrenheit defined
 * over kelvin resolves with its ConversionOffset, as the additive SI offset
 * `siOffset` (`si = value * siScale + siOffset`, so 68 °F is 293.15 K).
 */

function indexIfc(content: string): { source: Uint8Array; entityIndex: EntityIndex } {
  const source = new TextEncoder().encode(content);
  const byId = new Map<number, EntityRef>();
  const byType = new Map<string, number[]>();
  const re = /^#(\d+)=([A-Z0-9_]+)\(/;
  let offset = 0;
  let lineNumber = 0;
  for (const line of content.split('\n')) {
    lineNumber += 1;
    const m = re.exec(line);
    if (m) {
      const expressId = Number(m[1]);
      byId.set(expressId, { expressId, type: m[2], byteOffset: offset, byteLength: line.length, lineNumber });
      byType.set(m[2], [...(byType.get(m[2]) ?? []), expressId]);
    }
    offset += line.length + 1; // fixtures are pure ASCII
  }
  return { source, entityIndex: { byId, byType } };
}

function project(component: string, offset = '-459.67'): string {
  return [
    "#1=IFCPROJECT('0xScRe4drECQ4DMSqUjd6d',$,'P',$,$,$,$,$,#2);",
    '#2=IFCUNITASSIGNMENT((#5));',
    '#3=IFCDIMENSIONALEXPONENTS(0,0,0,0,1,0,0);',
    `#4=${component};`,
    `#5=IFCCONVERSIONBASEDUNITWITHOFFSET(#3,.THERMODYNAMICTEMPERATUREUNIT.,'Fahrenheit',#6,${offset});`,
    '#6=IFCMEASUREWITHUNIT(IFCTHERMODYNAMICTEMPERATUREMEASURE(0.5555555555555556),#4);',
  ].join('\n');
}

function temperatureUnit(content: string) {
  const { source, entityIndex } = indexIfc(content);
  return extractProjectUnits(source, entityIndex).resolvedForUnitType('THERMODYNAMICTEMPERATUREUNIT');
}

describe('IfcConversionBasedUnitWithOffset', () => {
  it('resolves a degree Fahrenheit over kelvin with its offset', () => {
    const unit = temperatureUnit(project('IFCSIUNIT(*,.THERMODYNAMICTEMPERATUREUNIT.,$,.KELVIN.)'));
    expect(unit?.siScale).toBeCloseTo(5 / 9, 12);
    expect(unit?.siOffset).toBeCloseTo(459.67 * 5 / 9, 9);
    expect(68 * unit!.siScale + unit!.siOffset!).toBeCloseTo(293.15, 9);
  });

  it('leaves the unit unresolved when its factor is in Celsius, which has its own offset', () => {
    expect(temperatureUnit(project('IFCSIUNIT(*,.THERMODYNAMICTEMPERATUREUNIT.,$,.DEGREE_CELSIUS.)'))).toBeUndefined();
  });

  it('leaves the unit unresolved when its offset is unset', () => {
    expect(temperatureUnit(project('IFCSIUNIT(*,.THERMODYNAMICTEMPERATUREUNIT.,$,.KELVIN.)', '$'))).toBeUndefined();
  });

  it('scales a measure value in it to kelvin, offset included', () => {
    const { source, entityIndex } = indexIfc(project('IFCSIUNIT(*,.THERMODYNAMICTEMPERATUREUNIT.,$,.KELVIN.)'));
    const units = extractProjectUnits(source, entityIndex);
    expect(scaleMeasureValue(68, 'IFCTHERMODYNAMICTEMPERATUREMEASURE', units) as number).toBeCloseTo(293.15, 9);
  });
});
