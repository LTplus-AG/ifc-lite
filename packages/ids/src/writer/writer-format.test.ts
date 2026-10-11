/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `writeIdsXml`'s formatting options (IDS-012). The canonical layout IS a
 * compatibility contract (two tools writing the same checks must produce the
 * same bytes, so diffs show only real changes), which is why it is pinned to a
 * golden file. Regenerate it deliberately with `UPDATE_GOLDEN=1`.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IDSDocument } from '../types.js';
import { parseIDS } from '../parser/xml-parser.js';
import { auditIDSDocument } from '../audit/index.js';
import { writeIdsXml, type IdsXmlFormat } from './index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN = join(HERE, '__golden__', 'canonical.ids');
const CORPUS = join(HERE, '../__corpus__/buildingsmart-ids');

const simple = (value: string) => ({ type: 'simpleValue', value }) as const;

/** Applicability out of XSD order and versions out of schema order, so canonical mode has work to do. */
const DOC: IDSDocument = {
  info: {
    title: 'Canonical layout', copyright: 'CC0', version: '1.0.0', description: 'Golden file for the writer',
    author: 'someone@example.org', date: '2026-10-08', purpose: 'Testing', milestone: 'Design',
  },
  specifications: [{
    id: 'walls', identifier: 'walls', name: 'Fire-rated walls', ifcVersions: ['IFC4X3', 'IFC2X3', 'IFC4'],
    description: 'External walls', instructions: 'Rate every external wall.', minOccurs: 1, maxOccurs: 'unbounded',
    applicability: { facets: [
      { type: 'property', propertySet: simple('Pset_WallCommon'), baseName: simple('IsExternal'), dataType: simple('IFCBOOLEAN'), value: simple('true') },
      { type: 'entity', name: simple('IFCWALL'), predefinedType: { type: 'enumeration', base: 'xs:string', values: ['SOLIDWALL', 'SHEAR'] } },
      { type: 'partOf', relation: 'IfcRelContainedInSpatialStructure', entity: { type: 'entity', name: simple('IFCBUILDINGSTOREY') } },
    ] },
    requirements: [
      { id: 'r0', optionality: 'required', instructions: 'From the fire strategy.', facet: {
        type: 'property', propertySet: simple('Pset_WallCommon'), baseName: simple('FireRating'), dataType: simple('IFCLABEL'),
        value: { type: 'pattern', base: 'xs:string', pattern: 'EI[0-9]+', and: [{ type: 'bounds', base: 'xs:string', minLength: 3, maxLength: 5 }] } } },
      { id: 'r1', optionality: 'optional', facet: {
        type: 'property', propertySet: simple('Qto_WallBaseQuantities'), baseName: simple('Width'), dataType: simple('IFCLENGTHMEASURE'),
        value: { type: 'bounds', base: 'xs:double', minExclusive: 0, maxInclusive: 0.5 } } },
      { id: 'r2', optionality: 'prohibited', facet: { type: 'attribute', name: simple('Description'), value: simple('TBD') } },
    ],
  }],
};

function corpusFiles(): string[] {
  const out: string[] = [];
  for (const group of readdirSync(CORPUS).sort()) {
    const dir = join(CORPUS, group);
    if (!statSync(dir).isDirectory()) continue;
    for (const name of readdirSync(dir).sort()) {
      if (name.endsWith('.ids') && !name.startsWith('invalid-')) out.push(join(dir, name));
    }
  }
  return out;
}

describe('writeIdsXml formatting (IDS-012)', () => {
  it('writes the canonical layout byte for byte (golden file)', async () => {
    const xml = writeIdsXml(DOC, { canonical: true });
    if (process.env.UPDATE_GOLDEN === '1') writeFileSync(GOLDEN, xml);
    expect(xml).toBe(readFileSync(GOLDEN, 'utf8'));
    // Canonical order is the XSD's, so the canonical output is schema-valid where the authored order was not.
    const audit = await auditIDSDocument(xml);
    expect(audit.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
  });

  it('only reorders what IDS treats as unordered: the checks read back the same', () => {
    const reread = parseIDS(writeIdsXml(DOC, { canonical: true })).specifications[0];
    const authored = DOC.specifications[0];
    expect(reread.applicability.facets.map((f) => f.type)).toEqual(['entity', 'partOf', 'property']);
    const [property, entity, partOf] = authored.applicability.facets;
    expect(reread.applicability.facets).toEqual([entity, partOf, property]);
    expect(reread.requirements.map((r) => r.facet)).toEqual(authored.requirements.map((r) => r.facet));
    expect(reread.ifcVersions).toEqual(['IFC2X3', 'IFC4', 'IFC4X3']);
  });

  it('indents with the given unit and ends lines with the given newline, nothing else changes', () => {
    const base = writeIdsXml(DOC);
    const tabbed = writeIdsXml(DOC, { indent: '\t', newline: '\r\n' });
    expect(tabbed.replace(/\r\n/g, '\n').replace(/^\t+/gm, (tabs) => '  '.repeat(tabs.length))).toBe(base);
    expect(writeIdsXml(DOC, { indent: 4 }).split('\n')[2]).toBe('    <info>');
    expect(writeIdsXml(DOC, { indent: 0 }).split('\n')[2]).toBe('<info>');
    expect(() => writeIdsXml(DOC, { indent: 1.5 })).toThrow(/indent must be/);
    expect(parseIDS(tabbed).specifications[0].requirements[0].instructions).toBe('From the fire strategy.');
  });

  // Idempotence: once written, re-reading and re-writing changes nothing, for
  // every layout and every well-formed case of the buildingSMART corpus.
  const formats: IdsXmlFormat[] = [{}, { canonical: true }, { canonical: true, indent: '\t', newline: '\r\n' }];
  for (const fmt of formats) {
    it(`write(parse(write(doc))) is write(doc) across the corpus with ${JSON.stringify(fmt)}`, () => {
      const drift: string[] = [];
      for (const file of corpusFiles()) {
        const once = writeIdsXml(parseIDS(readFileSync(file, 'utf8')), fmt);
        const twice = writeIdsXml(parseIDS(once), fmt);
        if (once !== twice) drift.push(file);
      }
      expect(drift).toEqual([]);
    });
  }
});
