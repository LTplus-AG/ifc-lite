/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IDS 1.1 PREVIEW (IDS-124): each candidate feature is invisible without the
 * flag and round-trips with it. Feature semantics and their upstream sources
 * are in `features.ts`; the conservative readings are in the P-12 worklog.
 */

import { describe, expect, it } from 'vitest';
import { parseIDS } from '../parser/xml-parser.js';
import { writeIdsXml } from '../writer/index.js';
import { auditIDSDocument } from '../audit/index.js';
import { validateIDS } from '../validation/validator.js';
import { createMockAccessor } from '../facets/test-helpers.js';
import { IDS11PreviewRequiredError, findIds11Features } from './features.js';
import { createTranslationService } from '../translation/index.js';
import type { IDSAuditIssue } from '../audit/types.js';

const PREVIEW = { preview: { ids11: true } } as const;

function ids(specifications: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ids xmlns="http://standards.buildingsmart.org/IDS" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://standards.buildingsmart.org/IDS http://standards.buildingsmart.org/IDS/1.0/ids.xsd">
  <info><title>preview</title></info>
  <specifications>${specifications}</specifications>
</ids>`;
}

const URI_IN_APPLICABILITY = ids(`
  <specification name="Fire rating" ifcVersion="IFC4" identifier="S1">
    <applicability minOccurs="0" maxOccurs="unbounded">
      <entity><name><simpleValue>IFCWALL</simpleValue></name></entity>
      <property dataType="IFCLABEL" uri="https://identifier.buildingsmart.org/uri/buildingsmart/ifc/4.3/prop/FireRating" instructions="Use the fire rating from the fire strategy">
        <propertySet><simpleValue>Pset_WallCommon</simpleValue></propertySet>
        <baseName><simpleValue>FireRating</simpleValue></baseName>
      </property>
    </applicability>
    <requirements>
      <attribute cardinality="required"><name><simpleValue>Name</simpleValue></name></attribute>
    </requirements>
  </specification>`);

const NESTED_PARTOF = ids(`
  <specification name="Spaces on storey 01" ifcVersion="IFC4" identifier="S2">
    <applicability minOccurs="0" maxOccurs="unbounded">
      <entity><name><simpleValue>IFCSPACE</simpleValue></name></entity>
      <partOf relation="IFCRELAGGREGATES">
        <entity><name><simpleValue>IFCBUILDINGSTOREY</simpleValue></name></entity>
        <attribute><name><simpleValue>Name</simpleValue></name><value><simpleValue>01</simpleValue></value></attribute>
      </partOf>
    </applicability>
    <requirements>
      <attribute cardinality="required">
        <name><simpleValue>Name</simpleValue></name>
        <value><xs:restriction base="xs:string"><xs:pattern value="01-.*"/></xs:restriction></value>
      </attribute>
    </requirements>
  </specification>`);

const errors = (issues: IDSAuditIssue[]) => issues.filter((i) => i.severity === 'error');

describe('IDS 1.1 preview: off by default', () => {
  it('a default parse reads none of the 1.1 candidates', () => {
    for (const xml of [URI_IN_APPLICABILITY, NESTED_PARTOF]) {
      expect(findIds11Features(parseIDS(xml))).toEqual([]);
    }
  });

  it('the default audit still rejects the 1.1 shapes as IDS 1.0', async () => {
    const uri = await auditIDSDocument(URI_IN_APPLICABILITY);
    expect(errors(uri.issues).map((i) => i.detail?.attribute).sort()).toEqual(['instructions', 'uri']);
    const nested = await auditIDSDocument(NESTED_PARTOF);
    expect(errors(nested.issues).map((i) => i.detail?.child)).toEqual(['attribute']);
  });

  it('the writer refuses a document with 1.1 features unless the flag is set', () => {
    const doc = parseIDS(NESTED_PARTOF, PREVIEW);
    expect(() => writeIdsXml(doc)).toThrow(IDS11PreviewRequiredError);
    expect(() => writeIdsXml(doc)).toThrow(/partOf.*specifications\[0\]\.applicability\.facets\[1\]/);
  });
});

describe('IDS 1.1 preview: uri and instructions on applicability facets (#188, #251, #154)', () => {
  it('parses, audits clean, and round-trips', async () => {
    const doc = parseIDS(URI_IN_APPLICABILITY, PREVIEW);
    const facet = doc.specifications[0]!.applicability.facets[1]!;
    expect(facet.type === 'property' && facet.uri).toBe('https://identifier.buildingsmart.org/uri/buildingsmart/ifc/4.3/prop/FireRating');
    expect(facet.instructions).toBe('Use the fire rating from the fire strategy');
    expect(findIds11Features(doc).map((u) => u.feature)).toEqual([
      'facet-uri-in-applicability',
      'facet-instructions-in-applicability',
    ]);

    const report = await auditIDSDocument(URI_IN_APPLICABILITY, PREVIEW);
    expect(errors(report.issues)).toEqual([]);
    expect(report.issues.filter((i) => i.code === 'I_IDS11_PREVIEW_FEATURE')).toHaveLength(2);

    const written = writeIdsXml(doc, {}, PREVIEW);
    expect(written).toContain('http://standards.buildingsmart.org/IDS/1.1/ids.xsd');
    expect(written).toContain('<!-- IDS 1.1 PREVIEW');
    expect(parseIDS(written, PREVIEW).specifications).toEqual(doc.specifications);
    expect(errors((await auditIDSDocument(written, PREVIEW)).issues)).toEqual([]);
  });

  it('refuses facet-level instructions on a requirement facet (one home per context)', () => {
    const doc = parseIDS(URI_IN_APPLICABILITY, PREVIEW);
    doc.specifications[0]!.requirements[0]!.facet.instructions = 'misplaced';
    expect(() => writeIdsXml(doc, {}, PREVIEW)).toThrow(/use IDSRequirement\.instructions/);
  });
});

describe('IDS 1.1 preview: facets nested in partOf (#379, draft PR #380)', () => {
  // The #379 use case: spaces of storey "01" must be named "01-…".
  const model = createMockAccessor([
    { expressId: 1, type: 'IFCBUILDINGSTOREY', name: '01', attributes: { Name: '01' } },
    { expressId: 2, type: 'IFCBUILDINGSTOREY', name: '02', attributes: { Name: '02' } },
    { expressId: 10, type: 'IFCSPACE', name: '01-Office', attributes: { Name: '01-Office' }, parent: { expressId: 1, type: 'IFCBUILDINGSTOREY', relation: 'IfcRelAggregates' } },
    { expressId: 11, type: 'IFCSPACE', name: 'Lobby', attributes: { Name: 'Lobby' }, parent: { expressId: 1, type: 'IFCBUILDINGSTOREY', relation: 'IfcRelAggregates' } },
    { expressId: 12, type: 'IFCSPACE', name: '02-Store', attributes: { Name: '02-Store' }, parent: { expressId: 2, type: 'IFCBUILDINGSTOREY', relation: 'IfcRelAggregates' } },
  ]);
  const modelInfo = { modelId: 'mock', schemaVersion: 'IFC4', entityCount: 5 };

  it('applies the nested facets to the related element, not to the element itself', async () => {
    const doc = parseIDS(NESTED_PARTOF, PREVIEW);
    const report = await validateIDS(doc, model, modelInfo, PREVIEW);
    const result = report.specificationResults[0]!;
    // Space 12 sits on storey 02, so it is not applicable; 10 passes, 11 fails.
    expect(result.entityResults.map((e) => [e.expressId, e.passed])).toEqual([[10, true], [11, false]]);
    expect(result.status).toBe('fail');
  });

  it('refuses to validate without the flag rather than ignoring the nested condition', async () => {
    const doc = parseIDS(NESTED_PARTOF, PREVIEW);
    await expect(validateIDS(doc, model, modelInfo)).rejects.toThrow(IDS11PreviewRequiredError);
  });

  it('describes the nested condition in reports, labelled by brackets', () => {
    const partOf = parseIDS(NESTED_PARTOF, PREVIEW).specifications[0]!.applicability.facets[1]!;
    const plain = parseIDS(NESTED_PARTOF).specifications[0]!.applicability.facets[1]!;
    const en = createTranslationService('en');
    const base = en.describeFacet(plain, 'applicability');
    expect(en.describeFacet(partOf, 'applicability')).toBe(
      `${base} [${en.describeFacet({ type: 'attribute', name: { type: 'simpleValue', value: 'Name' }, value: { type: 'simpleValue', value: '01' } }, 'applicability')}]`,
    );
  });

  it('round-trips through the writer and audits clean', async () => {
    const doc = parseIDS(NESTED_PARTOF, PREVIEW);
    const written = writeIdsXml(doc, {}, PREVIEW);
    expect(parseIDS(written, PREVIEW).specifications).toEqual(doc.specifications);
    expect(errors((await auditIDSDocument(written, PREVIEW)).issues)).toEqual([]);
  });

  it('needs exactly one related entity (conservative reading of the #380 xs:choice)', async () => {
    const twoEntities = NESTED_PARTOF.replace(
      '<entity><name><simpleValue>IFCBUILDINGSTOREY</simpleValue></name></entity>',
      '<entity><name><simpleValue>IFCBUILDINGSTOREY</simpleValue></name></entity><entity><name><simpleValue>IFCBUILDING</simpleValue></name></entity>',
    );
    const report = await auditIDSDocument(twoEntities, PREVIEW);
    expect(errors(report.issues).map((i) => i.message)).toEqual([
      expect.stringContaining('exactly one <entity>'),
    ]);
  });
});

describe('IDS 1.1 preview: identifiers (#339)', () => {
  it('warns on a duplicate specification identifier only under the preview', async () => {
    const spec = (name: string) => `
      <specification name="${name}" ifcVersion="IFC4" identifier="FIRE-01">
        <applicability minOccurs="0" maxOccurs="unbounded"><entity><name><simpleValue>IFCWALL</simpleValue></name></entity></applicability>
      </specification>`;
    const xml = ids(spec('A') + spec('B'));
    const plain = await auditIDSDocument(xml);
    expect(plain.issues.filter((i) => i.code === 'W_IDS11_IDENTIFIER_DUPLICATE')).toEqual([]);
    const preview = await auditIDSDocument(xml, PREVIEW);
    expect(preview.issues.filter((i) => i.code === 'W_IDS11_IDENTIFIER_DUPLICATE').map((i) => i.path)).toEqual([
      'specifications[1].identifier',
    ]);
    expect(preview.status).toBe('warning');
  });
});
