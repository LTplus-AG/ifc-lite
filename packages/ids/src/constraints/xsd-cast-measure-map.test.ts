/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ifcMeasureToXsdTypes` is hand-written. The repository already ships an
 * authoritative counterpart for the same question: the generated
 * `xsdTypesByEntity` table in `@ifc-lite/data`, transcribed from upstream
 * `IDS-Audit-tool`'s `SchemaInfo.Attributes.g.cs` — the very table the
 * ATTRIBUTE facet gates on (`attribute-facet.ts` →
 * `accessor.getAttributeXsdTypes`). Two strict-cast gates on one file that
 * disagree about a measure let the same literal pass one facet and fail the
 * other.
 *
 * This test pins the hand map against that table for `IfcTimeStamp` in BOTH
 * directions: a literal the authoritative slot accepts must be accepted here,
 * and one it rejects must be rejected here.
 */

import { describe, expect, it } from 'vitest';
import { getAttributeXsdTypes, type IfcSchemaVersion } from '@ifc-lite/data';
import { ifcMeasureToXsdTypes, literalCastsUnderAnyType } from './xsd-cast.js';

/**
 * Every attribute in the bundled schemas whose EXPRESS declared type is
 * `IfcTimeStamp` (`TYPE IfcTimeStamp = INTEGER;` in IFC4_ADD2_TC1.exp and
 * IFC4X3.exp). Named rather than counted: a count floor stays silent when the
 * row that matters is the one that goes missing, and reds on benign growth.
 */
const TIMESTAMP_ATTRIBUTES = [
  { entity: 'IfcOwnerHistory', attribute: 'CreationDate' },
  { entity: 'IfcOwnerHistory', attribute: 'LastModifiedDate' },
] as const;

const VERSIONS: readonly IfcSchemaVersion[] = ['IFC2X3', 'IFC4', 'IFC4X3'];

/** A UNIX epoch second — the value space of `IfcTimeStamp`. */
const EPOCH_LITERAL = '1609459200';
/** An ISO-8601 duration — the value space of `IfcDuration`, NOT of a timestamp. */
const DURATION_LITERAL = 'P1Y2M3D';

describe('ifcMeasureToXsdTypes agrees with the generated attribute XSD table', () => {
  it('the authoritative table actually carries the IfcTimeStamp slots (anti-vacuity)', () => {
    for (const version of VERSIONS) {
      for (const { entity, attribute } of TIMESTAMP_ATTRIBUTES) {
        const types = getAttributeXsdTypes(version, entity, attribute);
        expect(
          types,
          `${version} ${entity}.${attribute} has no XSD types — the derivation below would be vacuous`
        ).toBeDefined();
        expect(types!.length).toBeGreaterThan(0);
      }
    }
  });

  it('the hand map for IfcTimeStamp is a real gate, not an empty no-op (anti-vacuity)', () => {
    expect(ifcMeasureToXsdTypes('IFCTIMESTAMP').length).toBeGreaterThan(0);
  });

  it('accepts every literal the authoritative IfcTimeStamp slot accepts', () => {
    const handTypes = ifcMeasureToXsdTypes('IFCTIMESTAMP');
    for (const version of VERSIONS) {
      for (const { entity, attribute } of TIMESTAMP_ATTRIBUTES) {
        const authTypes = getAttributeXsdTypes(version, entity, attribute)!;
        expect(
          literalCastsUnderAnyType(EPOCH_LITERAL, authTypes),
          `authoritative ${version} ${entity}.${attribute} should accept an epoch integer`
        ).toBe(true);
        expect(
          literalCastsUnderAnyType(EPOCH_LITERAL, handTypes),
          `ifcMeasureToXsdTypes('IFCTIMESTAMP') rejects ${EPOCH_LITERAL}, which ${version} ` +
            `${entity}.${attribute} accepts — the property facet can never pass a timestamp check`
        ).toBe(true);
      }
    }
  });

  it('rejects a literal the authoritative IfcTimeStamp slot rejects', () => {
    const handTypes = ifcMeasureToXsdTypes('IFCTIMESTAMP');
    for (const version of VERSIONS) {
      for (const { entity, attribute } of TIMESTAMP_ATTRIBUTES) {
        const authTypes = getAttributeXsdTypes(version, entity, attribute)!;
        expect(
          literalCastsUnderAnyType(DURATION_LITERAL, authTypes),
          `authoritative ${version} ${entity}.${attribute} should reject an ISO duration`
        ).toBe(false);
        expect(
          literalCastsUnderAnyType(DURATION_LITERAL, handTypes),
          `ifcMeasureToXsdTypes('IFCTIMESTAMP') accepts ${DURATION_LITERAL}, which ${version} ` +
            `${entity}.${attribute} rejects`
        ).toBe(false);
      }
    }
  });

  /**
   * Control: the neighbouring measures the timestamp row was bundled with.
   * A "fix" that widened the gate for everything — or dropped it — breaks
   * these, so a regression cannot satisfy the two assertions above by
   * making every measure answer the same way.
   */
  it('leaves IfcDuration and IfcDate discriminating (control)', () => {
    const duration = ifcMeasureToXsdTypes('IFCDURATION');
    expect(literalCastsUnderAnyType(DURATION_LITERAL, duration)).toBe(true);
    expect(literalCastsUnderAnyType(EPOCH_LITERAL, duration)).toBe(false);

    const date = ifcMeasureToXsdTypes('IFCDATE');
    expect(literalCastsUnderAnyType('2021-01-01', date)).toBe(true);
    expect(literalCastsUnderAnyType(DURATION_LITERAL, date)).toBe(false);
    expect(literalCastsUnderAnyType(EPOCH_LITERAL, date)).toBe(false);
  });
});
