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

/**
 * The union across schema versions was itself a disagreement, in the
 * opposite direction from the one #3250 fixed.
 *
 * `IfcOwnerHistory.CreationDate` carries `["xs:integer"]` under IFC2X3 but
 * `["xs:dateTime","xs:integer"]` under IFC4 and IFC4X3. A measure-keyed
 * answer of `['xs:integer','xs:dateTime']` for EVERY version therefore let an
 * ISO-8601 date-time literal pass the property facet's strict-cast gate on an
 * IFC2X3 file while the attribute facet rejected it — the exact split the
 * mapping is supposed to mirror away. `ifcMeasureToXsdTypes` now takes the
 * schema version, so these pin the per-version answer rather than a union
 * that is wrong somewhere.
 */
describe('ifcMeasureToXsdTypes answers IfcTimeStamp per schema version', () => {
  /** An ISO-8601 date-time — accepted by the IFC4 slot, NOT by the IFC2X3 one. */
  const DATETIME_LITERAL = '2021-01-01T00:00:00Z';

  it('matches the authoritative CreationDate slot exactly, in every version', () => {
    for (const version of VERSIONS) {
      const authTypes = getAttributeXsdTypes(version, 'IfcOwnerHistory', 'CreationDate')!;
      const handTypes = ifcMeasureToXsdTypes('IFCTIMESTAMP', version);
      expect(
        [...handTypes].sort(),
        `${version}: the property facet's cast gate and the attribute facet's ` +
          `table disagree on IfcTimeStamp, so one file gets two verdicts`
      ).toEqual([...authTypes].sort());
    }
  });

  it('splits on the date-time literal exactly where the schemas do', () => {
    // The case that fails against a version-blind union: IFC2X3 must refuse
    // what IFC4 accepts. Asserted through the same cast helper the facets
    // use, not by comparing type lists, so it pins the observable verdict.
    expect(
      literalCastsUnderAnyType(DATETIME_LITERAL, ifcMeasureToXsdTypes('IFCTIMESTAMP', 'IFC2X3')),
      `IFC2X3 accepted ${DATETIME_LITERAL}; its CreationDate slot is xs:integer alone, ` +
        `so the attribute facet rejects it on the same file`
    ).toBe(false);
    for (const version of ['IFC4', 'IFC4X3'] as const) {
      expect(
        literalCastsUnderAnyType(DATETIME_LITERAL, ifcMeasureToXsdTypes('IFCTIMESTAMP', version)),
        `${version} refused ${DATETIME_LITERAL}, which its CreationDate slot accepts`
      ).toBe(true);
    }
  });

  it('still accepts the epoch integer in every version — the #3250 regression', () => {
    // The narrowing above must not walk back the original fix: an epoch
    // second is the value space of IfcTimeStamp and every schema takes it.
    for (const version of VERSIONS) {
      expect(
        literalCastsUnderAnyType(EPOCH_LITERAL, ifcMeasureToXsdTypes('IFCTIMESTAMP', version)),
        `${version} rejects ${EPOCH_LITERAL} — the property facet can never pass a timestamp check`
      ).toBe(true);
    }
    // And an ISO duration stays refused everywhere, per-version included.
    for (const version of VERSIONS) {
      expect(
        literalCastsUnderAnyType(DURATION_LITERAL, ifcMeasureToXsdTypes('IFCTIMESTAMP', version))
      ).toBe(false);
    }
  });

  it('an unknown or absent version keeps the permissive union (documented fallback)', () => {
    // A caller with no version must not silently get IFC2X3's stricter
    // answer — a gate that cannot tell which schema it is reading should
    // defer, not reject a value some schema allows.
    expect([...ifcMeasureToXsdTypes('IFCTIMESTAMP', undefined)].sort()).toEqual([
      'xs:dateTime',
      'xs:integer',
    ]);
    expect([...ifcMeasureToXsdTypes('IFCTIMESTAMP', 'IFC4X9')].sort()).toEqual([
      'xs:dateTime',
      'xs:integer',
    ]);
  });
});
