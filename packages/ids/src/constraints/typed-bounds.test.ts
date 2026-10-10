/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #7399: `xs:minInclusive` / `xs:maxInclusive` / `xs:minExclusive` /
 * `xs:maxExclusive` were read with `parseFloat` whatever the restriction's
 * `@base`, and so was the value they bound. A date range [2024-01-01,
 * 2024-03-31] became [2024, 2024], which `2024-12-31` (also 2024) satisfied;
 * and `"6,5"` under `xs:double` became 6, silently, with no audit finding.
 *
 * Bounds are now read by their base: a numeric base takes only a lexeme in
 * that base's lexical space, the date/time family and `xs:duration` compare
 * by value in XSD's order, and a bound outside its base's lexical space fails
 * the restriction closed and is reported by the audit.
 */

import { IfcParser } from '@ifc-lite/parser';
import { parseIDS } from '../parser/xml-parser.js';
import { matchConstraint, getConstraintMismatchReason, formatConstraint } from './index.js';
import { auditIDSDocument } from '../audit/index.js';
import { validateIDS } from '../validation/validator.js';
import { createDataAccessor } from '../bridge/data-accessor.js';
import type { IDSBoundsConstraint } from '../types.js';

const idsWith = (base: string, facets: string): string => `<?xml version="1.0" encoding="UTF-8"?>
<ids xmlns="http://standards.buildingsmart.org/IDS" xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <info><title>bounds</title></info>
  <specifications>
    <specification name="Test" ifcVersion="IFC4">
      <applicability><entity><name><simpleValue>IFCWALL</simpleValue></name></entity></applicability>
      <requirements>
        <property>
          <propertySet><simpleValue>Probe_Set</simpleValue></propertySet>
          <baseName><simpleValue>P</simpleValue></baseName>
          <value><xs:restriction base="${base}">${facets}</xs:restriction></value>
        </property>
      </requirements>
    </specification>
  </specifications>
</ids>`;

const boundsOf = (base: string, facets: string): IDSBoundsConstraint => {
  const facet = parseIDS(idsWith(base, facets)).specifications[0].requirements[0].facet;
  const value = (facet as { value?: unknown }).value as IDSBoundsConstraint;
  expect(value.type).toBe('bounds');
  return value;
};

const range = (base: string, lo: string, hi: string): IDSBoundsConstraint =>
  boundsOf(base, `<xs:minInclusive value="${lo}"/><xs:maxInclusive value="${hi}"/>`);

describe('#7399 — the issue reproduction, end to end', () => {
  const IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [ReferenceView]'),'2;1');
FILE_NAME('probe.ifc','2026-10-10T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0000000000000000000001',$,'Project',$,$,$,$,(#4),#3);
#2=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#3=IFCUNITASSIGNMENT((#2));
#4=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#6,$);
#5=IFCCARTESIANPOINT((0.,0.,0.));
#6=IFCAXIS2PLACEMENT3D(#5,$,$);
#20=IFCWALL('0000000000000000000020',$,'W-1',$,$,$,$,$,$);
#21=IFCPROPERTYSINGLEVALUE('Inspected',$,IFCDATE('2024-12-31'),$);
#22=IFCPROPERTYSINGLEVALUE('Ratio',$,IFCREAL(6.2),$);
#24=IFCPROPERTYSET('0000000000000000000024',$,'Probe_Set',$,(#21,#22));
#25=IFCRELDEFINESBYPROPERTIES('0000000000000000000025',$,$,$,(#20),#24);
ENDSEC;
END-ISO-10303-21;
`;
  const spec = (name: string, dataType: string, prop: string, restriction: string): string => `
    <specification name="${name}" ifcVersion="IFC4">
      <applicability minOccurs="0" maxOccurs="unbounded"><entity><name><simpleValue>IFCWALL</simpleValue></name></entity></applicability>
      <requirements><property dataType="${dataType}"><propertySet><simpleValue>Probe_Set</simpleValue></propertySet><baseName><simpleValue>${prop}</simpleValue></baseName><value>${restriction}</value></property></requirements>
    </specification>`;
  const IDS = `<?xml version="1.0" encoding="UTF-8"?>
<ids xmlns="http://standards.buildingsmart.org/IDS" xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <info><title>probe</title></info>
  <specifications>${spec(
    'date between 2024-01-01 and 2024-03-31',
    'IFCDATE',
    'Inspected',
    '<xs:restriction base="xs:date"><xs:minInclusive value="2024-01-01"/><xs:maxInclusive value="2024-03-31"/></xs:restriction>',
  )}${spec(
    'ratio at least 6,5',
    'IFCREAL',
    'Ratio',
    '<xs:restriction base="xs:double"><xs:minInclusive value="6,5"/></xs:restriction>',
  )}
  </specifications>
</ids>`;

  it('fails W-1 on both requirements (both passed before the fix)', async () => {
    const bytes = new TextEncoder().encode(IFC);
    const store = await new IfcParser().parseColumnar(bytes.buffer.slice(0), { disableWorkerScan: true });
    const report = await validateIDS(
      parseIDS(IDS),
      createDataAccessor(store),
      { modelId: 'bounds', schemaVersion: store.schemaVersion, entityCount: store.entityCount },
      { includePassingEntities: true },
    );
    const [date, ratio] = report.specificationResults;
    expect(date.applicableCount).toBe(1);
    expect(date.status).toBe('fail');
    expect(ratio.applicableCount).toBe(1);
    expect(ratio.status).toBe('fail');
  });

  it('the audit flags "6,5" as outside xs:double, and nothing on the valid date bounds', async () => {
    const { issues } = await auditIDSDocument(IDS);
    const unparseable = issues.filter((i) => i.code === 'E_RESTRICTION_FACET_UNPARSEABLE');
    expect(unparseable).toHaveLength(1);
    expect(unparseable[0].detail).toMatchObject({ facet: 'minInclusive', rawValue: '6,5' });
    expect(unparseable[0].message).toContain('xs:double');
  });
});

describe('#7399 — numeric bases read a bound only in their lexical space', () => {
  it('"6,5" under xs:double is rejected, not truncated to 6', () => {
    const c = boundsOf('xs:double', '<xs:minInclusive value="6,5"/>');
    expect(c.minInclusive).toBeUndefined();
    expect(c.unparseableFacets).toEqual([{ facet: 'minInclusive', rawValue: '6,5' }]);
    expect(matchConstraint(c, 6.2)).toBe(false);
    expect(matchConstraint(c, 7)).toBe(false);
    expect(getConstraintMismatchReason(c, 6.2)).toContain('xs:minInclusive="6,5"');
  });

  it('a date-shaped bound under xs:double is rejected, not read as its year', () => {
    const c = boundsOf('xs:double', '<xs:maxInclusive value="2024-03-31"/>');
    expect(c.unparseableFacets).toEqual([{ facet: 'maxInclusive', rawValue: '2024-03-31' }]);
    expect(matchConstraint(c, 2024)).toBe(false);
  });

  it('xs:integer rejects a decimal bound that xs:decimal accepts', () => {
    const integer = boundsOf('xs:integer', '<xs:minInclusive value="6.5"/>');
    expect(integer.unparseableFacets).toEqual([{ facet: 'minInclusive', rawValue: '6.5' }]);
    expect(matchConstraint(integer, 7)).toBe(false);

    const decimal = boundsOf('xs:decimal', '<xs:minInclusive value="6.5"/>');
    expect(decimal.unparseableFacets).toBeUndefined();
    expect(decimal.minInclusive).toBe(6.5);
    expect(matchConstraint(decimal, 6.5)).toBe(true);
    expect(matchConstraint(decimal, 6.4)).toBe(false);

    const wholeInteger = boundsOf('xs:integer', '<xs:minInclusive value="+6"/>');
    expect(wholeInteger.minInclusive).toBe(6);
    expect(matchConstraint(wholeInteger, 6)).toBe(true);
    expect(matchConstraint(wholeInteger, 5)).toBe(false);
  });

  it('keeps the lexemes the conformance corpus uses ("0.", exponents, signs)', () => {
    expect(boundsOf('xs:double', '<xs:minInclusive value="0."/>').minInclusive).toBe(0);
    expect(boundsOf('xs:double', '<xs:minInclusive value="1.5E3"/>').minInclusive).toBe(1500);
    expect(boundsOf('xs:double', '<xs:minInclusive value="-.5"/>').minInclusive).toBe(-0.5);
    expect(boundsOf('xs:double', '<xs:maxInclusive value="+INF"/>').maxInclusive).toBe(Infinity);
  });

  // PR #7411 review: the infinities are lexemes of xs:double and xs:float
  // only. xs:decimal, xs:integer and every integer derivation have no
  // infinity, so "+INF" there must fail closed, not accept every number.
  it.each([
    ['xs:decimal', '+INF'], ['xs:decimal', '-INF'], ['xs:decimal', 'INF'], ['xs:decimal', 'NaN'],
    ['xs:integer', '+INF'], ['xs:integer', '-INF'], ['xs:integer', 'NaN'],
    ['xs:nonNegativeInteger', '+INF'], ['xs:long', '-INF'], ['xs:unsignedByte', '+INF'],
    ['xs:string', '+INF'], ['xs:double', 'INF'], ['xs:double', 'NaN'], ['xs:float', 'NaN'],
  ])('under %s, the bound "%s" is unparseable and fails closed', (base, raw) => {
    const c = boundsOf(base, `<xs:maxInclusive value="${raw}"/>`);
    expect(c.maxInclusive).toBeUndefined();
    expect(c.unparseableFacets).toEqual([{ facet: 'maxInclusive', rawValue: raw }]);
    expect(matchConstraint(c, 1)).toBe(false);
    expect(matchConstraint(c, -1e300)).toBe(false);
  });

  it('xs:double and xs:float keep their infinities', () => {
    expect(boundsOf('xs:double', '<xs:minInclusive value="-INF"/>').minInclusive).toBe(-Infinity);
    expect(boundsOf('xs:float', '<xs:maxInclusive value="+INF"/>').maxInclusive).toBe(Infinity);
  });

  it('the audit flags an infinite bound under xs:decimal', async () => {
    const { issues } = await auditIDSDocument(idsWith('xs:decimal', '<xs:maxInclusive value="+INF"/>'));
    const flagged = issues.filter((i) => i.code === 'E_RESTRICTION_FACET_UNPARSEABLE');
    expect(flagged).toHaveLength(1);
    expect(flagged[0].message).toContain('xs:decimal');
  });

  it('a value that is not wholly numeric no longer satisfies a numeric bound by its prefix', () => {
    const c = range('xs:double', '0', '10');
    expect(matchConstraint(c, '5')).toBe(true);
    expect(matchConstraint(c, '5 m')).toBe(false);
    expect(matchConstraint(c, '2024-01-01')).toBe(false);
  });

  it('exclusive numeric bounds exclude the bound itself', () => {
    const c = boundsOf('xs:double', '<xs:minExclusive value="0"/><xs:maxExclusive value="10"/>');
    expect(matchConstraint(c, 0)).toBe(false);
    expect(matchConstraint(c, 10)).toBe(false);
    expect(matchConstraint(c, 0.5)).toBe(true);
  });

  it('a digit-count facet like "6,5" is rejected, not read as 6', () => {
    const c = boundsOf('xs:string', '<xs:maxLength value="6,5"/>');
    expect(c.maxLength).toBeUndefined();
    expect(c.unparseableFacets).toEqual([{ facet: 'maxLength', rawValue: '6,5' }]);
  });
});

describe('#7399 — xs:date / xs:dateTime / xs:time compare as dates and times', () => {
  it('xs:date: the issue range rejects 2024-12-31 and keeps 2024-02-29', () => {
    const c = range('xs:date', '2024-01-01', '2024-03-31');
    expect(c.minInclusive).toBeUndefined();
    expect(c.temporalBounds).toEqual({ minInclusive: '2024-01-01', maxInclusive: '2024-03-31' });
    expect(matchConstraint(c, '2024-12-31')).toBe(false);
    expect(matchConstraint(c, '2023-12-31')).toBe(false);
    expect(matchConstraint(c, '2024-01-01')).toBe(true);
    expect(matchConstraint(c, '2024-02-29')).toBe(true);
    expect(matchConstraint(c, '2024-03-31')).toBe(true);
    expect(formatConstraint(c)).toBe('between 2024-01-01 and 2024-03-31');
    expect(getConstraintMismatchReason(c, '2024-12-31')).toContain('<= 2024-03-31');
  });

  it('xs:date exclusive bounds exclude the bound day', () => {
    const c = boundsOf('xs:date', '<xs:minExclusive value="2024-01-01"/><xs:maxExclusive value="2024-01-03"/>');
    expect(matchConstraint(c, '2024-01-01')).toBe(false);
    expect(matchConstraint(c, '2024-01-02')).toBe(true);
    expect(matchConstraint(c, '2024-01-03')).toBe(false);
  });

  it('a value outside the base value space fails, whatever its prefix', () => {
    const c = range('xs:date', '2024-01-01', '2024-12-31');
    expect(matchConstraint(c, '2024')).toBe(false);
    expect(matchConstraint(c, 2024)).toBe(false);
    expect(matchConstraint(c, '2024-02-30')).toBe(false);
    expect(matchConstraint(c, '2024-06-15T00:00:00')).toBe(false);
  });

  it('xs:dateTime normalises time zones before comparing', () => {
    const c = boundsOf('xs:dateTime', '<xs:maxInclusive value="2024-06-15T12:00:00Z"/>');
    // 13:00 at +02:00 is 11:00Z — before the bound.
    expect(matchConstraint(c, '2024-06-15T13:00:00+02:00')).toBe(true);
    // 11:00 at -02:00 is 13:00Z — after it, though its clock reads earlier.
    expect(matchConstraint(c, '2024-06-15T11:00:00-02:00')).toBe(false);
    expect(matchConstraint(c, '2024-06-15T12:00:00Z')).toBe(true);
    expect(matchConstraint(c, '2024-06-15T12:00:00.001Z')).toBe(false);
    // Crossing midnight: 2024-06-16T01:00+14:00 is 2024-06-15T11:00Z.
    expect(matchConstraint(c, '2024-06-16T01:00:00+14:00')).toBe(true);
  });

  it('xs:dateTime: a zone-less value against a zoned bound is decided only outside the 14h window', () => {
    const c = boundsOf('xs:dateTime', '<xs:maxInclusive value="2024-06-15T12:00:00Z"/>');
    // Within ±14h the order is indeterminate in XSD; fail closed.
    expect(matchConstraint(c, '2024-06-15T11:00:00')).toBe(false);
    // More than 14h before the bound under any zone.
    expect(matchConstraint(c, '2024-06-14T21:00:00')).toBe(true);
    expect(matchConstraint(c, '2024-06-17T00:00:00')).toBe(false);
  });

  it('xs:time compares on the clock, normalised to UTC', () => {
    const c = boundsOf('xs:time', '<xs:minInclusive value="08:00:00Z"/><xs:maxExclusive value="17:00:00Z"/>');
    expect(matchConstraint(c, '09:30:00Z')).toBe(true);
    expect(matchConstraint(c, '17:00:00Z')).toBe(false);
    // 09:00 at +02:00 is 07:00Z.
    expect(matchConstraint(c, '09:00:00+02:00')).toBe(false);
    expect(matchConstraint(c, '25:00:00Z')).toBe(false);
  });

  it('an invalid date bound is rejected and reported, not compared', async () => {
    const c = boundsOf('xs:date', '<xs:minInclusive value="2024-13-01"/>');
    expect(c.temporalBounds).toBeUndefined();
    expect(c.unparseableFacets).toEqual([{ facet: 'minInclusive', rawValue: '2024-13-01' }]);
    expect(matchConstraint(c, '2024-06-01')).toBe(false);
    expect(formatConstraint(c)).toContain('xs:minInclusive="2024-13-01"');
    const { issues } = await auditIDSDocument(idsWith('xs:date', '<xs:minInclusive value="2024-13-01"/>'));
    const flagged = issues.filter((i) => i.code === 'E_RESTRICTION_FACET_UNPARSEABLE');
    expect(flagged).toHaveLength(1);
    expect(flagged[0].message).toContain('xs:date');
  });

  it('the audit flags inverted date bounds and not a valid range', async () => {
    const inverted = await auditIDSDocument(
      idsWith('xs:date', '<xs:minInclusive value="2024-12-31"/><xs:maxInclusive value="2024-01-01"/>'),
    );
    expect(inverted.issues.some((i) => i.code === 'E_RESTRICTION_RANGE')).toBe(true);
    const valid = await auditIDSDocument(
      idsWith('xs:date', '<xs:minInclusive value="2024-01-01"/><xs:maxInclusive value="2024-12-31"/>'),
    );
    expect(valid.issues.filter((i) => i.code.startsWith('E_RESTRICTION'))).toEqual([]);
  });
});

describe('#7399 — xs:duration compares in XSD order', () => {
  it('orders durations, and fails closed where XSD leaves the order indeterminate', () => {
    const c = boundsOf('xs:duration', '<xs:maxInclusive value="P1Y"/>');
    expect(matchConstraint(c, 'P11M')).toBe(true);
    expect(matchConstraint(c, 'P12M')).toBe(true);
    expect(matchConstraint(c, 'P13M')).toBe(false);
    expect(matchConstraint(c, 'P300D')).toBe(true);
    expect(matchConstraint(c, 'P400D')).toBe(false);
    // 366 days is a leap year but longer than a common one, so not <= P1Y.
    expect(matchConstraint(c, 'P366D')).toBe(false);
    expect(matchConstraint(c, 'PT1H')).toBe(true);
    expect(matchConstraint(c, '-P2Y')).toBe(true);
    expect(matchConstraint(c, '1 year')).toBe(false);
  });

  it('rejects a duration bound with no component', () => {
    const c = boundsOf('xs:duration', '<xs:maxInclusive value="P"/>');
    expect(c.unparseableFacets).toEqual([{ facet: 'maxInclusive', rawValue: 'P' }]);
  });
});
