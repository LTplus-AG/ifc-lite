/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { classifyEntityTypeConversion, analyzeConversionLoss } from './schema-conversion-loss-report.js';

describe('classifyEntityTypeConversion', () => {
  it('is identity when schemas match', () => {
    expect(classifyEntityTypeConversion('IFCWALL', 'IFC4', 'IFC4')).toEqual({
      targetType: 'IFCWALL',
      kind: 'identity',
      droppedAttributes: [],
    });
  });

  it('is renamed (lossless) for a type that passes through with no attribute drop', () => {
    const info = classifyEntityTypeConversion('IFCWALL', 'IFC4', 'IFC4X3');
    expect(info.kind).toBe('identity');
  });

  it('is lossy for the structural load-case rename: SelfWeightCoefficients has no IFC2X3 slot', () => {
    const info = classifyEntityTypeConversion('IFCSTRUCTURALLOADCASE', 'IFC4', 'IFC2X3');
    expect(info.targetType).toBe('IFCSTRUCTURALLOADGROUP');
    expect(info.kind).toBe('lossy');
    expect(info.droppedAttributes).toEqual(['SelfWeightCoefficients']);
  });

  it('is lossy for the structural curve-action rename: PredefinedType has no IFC2X3 slot', () => {
    const info = classifyEntityTypeConversion('IFCSTRUCTURALCURVEACTION', 'IFC4', 'IFC2X3');
    expect(info.targetType).toBe('IFCSTRUCTURALLINEARACTION');
    expect(info.kind).toBe('lossy');
    expect(info.droppedAttributes).toEqual(['PredefinedType']);
  });

  it('is proxied for a rooted type IFC2X3 has no representation for at all', () => {
    const info = classifyEntityTypeConversion('IFCSTRUCTURALCURVEREACTION', 'IFC4', 'IFC2X3');
    expect(info.kind).toBe('proxied');
    expect(info.targetType).toBe('IFCPROXY');
    expect(info.droppedAttributes.length).toBeGreaterThan(0);
  });

  it('is blocked for a non-rooted type IFC2X3 has no representation for at all', () => {
    const info = classifyEntityTypeConversion('IFCSTRUCTURALLOADCONFIGURATION', 'IFC4', 'IFC2X3');
    expect(info.kind).toBe('blocked');
    expect(info.droppedAttributes).toEqual(['Name', 'Values', 'Locations']);
  });

  it('matches the known IFCTRIANGULATEDFACESET blocked case (existing resolveUnrepresentedEntity contract)', () => {
    const info = classifyEntityTypeConversion('IFCTRIANGULATEDFACESET', 'IFC4', 'IFC2X3');
    expect(info.kind).toBe('blocked');
  });

  it('is proxied via shouldSkipEntity (not the attribute-table branch) and still names the dropped attributes', () => {
    // IFCALIGNMENTHORIZONTAL hits `shouldSkipEntity`, a DIFFERENT code path
    // than the `!tgtAttrs` branch the other proxied/blocked cases exercise —
    // both must report the same "every attribute is gone" shape.
    const info = classifyEntityTypeConversion('IFCALIGNMENTHORIZONTAL', 'IFC4X3', 'IFC4');
    expect(info).toEqual({
      targetType: 'IFCPROXY',
      kind: 'proxied',
      droppedAttributes: ['GlobalId', 'OwnerHistory', 'Name', 'Description', 'ObjectType', 'ObjectPlacement', 'Representation'],
    });
  });

  it('is identity for a lossless pad (IFC2X3 → IFC4 appends PredefinedType to IfcWall, nothing source-side disappears)', () => {
    const info = classifyEntityTypeConversion('IFCWALL', 'IFC2X3', 'IFC4');
    expect(info).toEqual({ targetType: 'IFCWALL', kind: 'identity', droppedAttributes: [] });
  });

  it('is lossy with an EMPTY droppedAttributes when same-named attributes exist on both sides but are reordered, not appended', () => {
    // IfcMaterialProperties: IFC2X3 ["Material"], IFC4 ["Name","Description",
    // "Properties","Material"] — "Material" exists in both, but not at
    // position 0, so neither list is a strict prefix of the other and
    // `convertRecord` leaves the single positional value under the new
    // 4-attribute shape untouched, landing it in `Name`'s slot instead of
    // vanishing. `droppedAttributes` correctly finds no NAME missing, even
    // though the record is misconverted.
    const info = classifyEntityTypeConversion('IFCMATERIALPROPERTIES', 'IFC2X3', 'IFC4');
    expect(info).toEqual({ targetType: 'IFCMATERIALPROPERTIES', kind: 'lossy', droppedAttributes: [] });
  });
});

describe('analyzeConversionLoss', () => {
  function storeOf(byType: Record<string, number[]>) {
    return { entityIndex: { byType: new Map(Object.entries(byType)), byId: new Map() as never } };
  }

  it('is empty when the schemas match', () => {
    const report = analyzeConversionLoss(storeOf({ IFCWALL: [1, 2] }), 'IFC4', 'IFC4');
    expect(report.hasLoss).toBe(false);
    expect(report.hasBlocking).toBe(false);
    expect(report.entries).toEqual([]);
  });

  it('omits identity types entirely (IfcWall is attribute-for-attribute unchanged IFC4 → IFC4X3)', () => {
    const report = analyzeConversionLoss(storeOf({ IFCWALL: [1], IFCSLAB: [2, 3] }), 'IFC4', 'IFC4X3');
    expect(report.entries).toEqual([]);
    expect(report.hasLoss).toBe(false);
  });

  it('does not silently report "no loss" for an IFC5 source (no generated attribute table, but shouldSkipEntity still proxies alignment types)', () => {
    const report = analyzeConversionLoss(storeOf({ IFCALIGNMENTHORIZONTAL: [1, 2] }), 'IFC5', 'IFC4');
    expect(report.hasLoss).toBe(true);
    expect(report.entries).toMatchObject([{ sourceType: 'IFCALIGNMENTHORIZONTAL', kind: 'proxied', count: 2 }]);
  });

  it('names every blocked and lossy structural type the real Constructivity fixture contains, with their express ids', () => {
    const report = analyzeConversionLoss(
      storeOf({
        IFCSTRUCTURALANALYSISMODEL: [209],
        IFCSTRUCTURALLOADCASE: [312],
        IFCSTRUCTURALCURVEACTION: [317],
        IFCSTRUCTURALLOADCONFIGURATION: [326, 2772, 2780, 2788],
        IFCSTRUCTURALCURVEREACTION: [2773, 2781, 2789],
      }),
      'IFC4',
      'IFC2X3',
    );

    expect(report.hasBlocking).toBe(true);
    expect(report.hasLoss).toBe(true);

    const byType = new Map(report.entries.map((e) => [e.sourceType, e]));
    // Pre-existing (not part of this fix): IFC4 appended `SharedPlacement` to
    // IfcStructuralAnalysisModel, so the strict-prefix trim into IFC2X3 drops
    // it — real, if minor, loss the report should still name.
    expect(byType.get('IFCSTRUCTURALANALYSISMODEL')).toMatchObject({
      kind: 'lossy',
      droppedAttributes: ['SharedPlacement'],
    });
    expect(byType.get('IFCSTRUCTURALLOADCASE')?.kind).toBe('lossy');
    expect(byType.get('IFCSTRUCTURALCURVEACTION')?.kind).toBe('lossy');
    expect(byType.get('IFCSTRUCTURALLOADCONFIGURATION')).toMatchObject({
      kind: 'blocked',
      count: 4,
      expressIds: [326, 2772, 2780, 2788],
    });
    expect(byType.get('IFCSTRUCTURALCURVEREACTION')).toMatchObject({ kind: 'proxied', count: 3 });

    const lines = report.describe();
    expect(lines.some((l) => l.includes('IFCSTRUCTURALLOADCONFIGURATION') && l.includes('#326'))).toBe(true);
    expect(lines.some((l) => l.includes('IFCSTRUCTURALCURVEREACTION'))).toBe(true);
  });

  it('skips a type the store lists with zero instances', () => {
    const report = analyzeConversionLoss(storeOf({ IFCSTRUCTURALLOADCONFIGURATION: [] }), 'IFC4', 'IFC2X3');
    expect(report.entries).toEqual([]);
  });
});
