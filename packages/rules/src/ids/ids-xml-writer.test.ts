/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The IDS writer against buildingSMART's own conformance corpus (#6915):
 * every pass/fail case is parsed, written back through `writeIdsXml`, parsed
 * again and validated on the case's IFC. The rewritten document must give the
 * same verdict as the original, and the specifications must read back the
 * same. A case using a constraint part the writer has no XML for must be
 * refused by name, never written as a weaker check.
 *
 * The corpus is CC BY-ND 4.0 and is only READ here (see the corpus README).
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IfcParser } from '@ifc-lite/parser';
import { auditIDSDocument, parseIDS, validateIDS, type IDSDocument } from '@ifc-lite/ids';
import { createDataAccessor } from '@ifc-lite/ids/bridge';
import { writeIdsXml } from './ids-xml-writer.js';

const CORPUS = join(dirname(fileURLToPath(import.meta.url)), '../../../ids/src/__corpus__/buildingsmart-ids');

function cases(): Array<{ id: string; ids: string; ifc: string }> {
  const out: Array<{ id: string; ids: string; ifc: string }> = [];
  for (const group of readdirSync(CORPUS).sort()) {
    const dir = join(CORPUS, group);
    if (!statSync(dir).isDirectory()) continue;
    for (const name of readdirSync(dir).sort()) {
      if (!name.endsWith('.ids') || !(name.startsWith('pass-') || name.startsWith('fail-'))) continue;
      out.push({ id: `${group}/${name}`, ids: join(dir, name), ifc: join(dir, name.replace(/\.ids$/, '.ifc')) });
    }
  }
  return out;
}

/** What a reader observes of the checks: parser bookkeeping (raw attribute echoes) excluded. */
function checks(doc: IDSDocument): unknown {
  return doc.specifications.map(({ ifcVersionRaw: _raw, applicability: { cardinality: _c, ...applicability }, requirements, ...spec }) => ({
    ...spec, applicability,
    requirements: requirements.map(({ cardinalityRaw: _r, description: _d, ...requirement }) => requirement),
  }));
}

async function verdicts(doc: IDSDocument, ifcPath: string): Promise<string[]> {
  const bytes = readFileSync(ifcPath);
  const store = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, { disableWorkerScan: true });
  const report = await validateIDS(doc, createDataAccessor(store), { modelId: 'corpus', schemaVersion: store.schemaVersion || 'IFC4', entityCount: store.entityCount });
  return report.specificationResults.map((spec) => `${spec.status}:${spec.applicableCount}:${spec.passedCount}:${spec.failedCount}`);
}

describe('writeIdsXml round-trips the buildingSMART IDS corpus (#6915)', () => {
  const all = cases();

  it('finds the vendored corpus', () => {
    expect(all.length).toBe(307);
  });

  it('every written case reads back unchanged and gives the original verdict; the rest are refused by name', async () => {
    let written = 0;
    const refused: string[] = [];
    const disagreements: string[] = [];
    for (const item of all) {
      const original = parseIDS(readFileSync(item.ids, 'utf8'));
      let xml: string;
      try { xml = writeIdsXml(original); }
      catch (error) {
        expect(String(error)).toMatch(/not supported by this writer|needs its related entity|must be a simple value/);
        refused.push(item.id);
        continue;
      }
      written++;
      const reread = parseIDS(xml);
      if (JSON.stringify(checks(reread)) !== JSON.stringify(checks(original))) disagreements.push(`${item.id}: structure`);
      const [before, after] = [await verdicts(original, item.ifc), await verdicts(reread, item.ifc)];
      if (before.join() !== after.join()) disagreements.push(`${item.id}: ${before.join()} -> ${after.join()}`);
    }
    expect(disagreements).toEqual([]);
    // Pinned so a writer that starts refusing more (or silently accepting less) is visible:
    // only the six xs:length / xs:minLength / xs:maxLength cases have no XML here.
    expect(written).toBe(301);
    expect(refused).toHaveLength(6);
    expect(refused.every((id) => /^restriction\/(pass|fail)-(max_and_min_)?length_checks/.test(id))).toBe(true);
  }, 120_000);

  it('dataType, partOf and requirement instructions survive and pass the native audit', async () => {
    const doc: IDSDocument = { info: { title: 'Writer coverage' }, specifications: [{
      id: 's', name: 'Storey walls', ifcVersions: ['IFC4'], minOccurs: 1, maxOccurs: 'unbounded',
      applicability: { facets: [
        { type: 'entity', name: { type: 'simpleValue', value: 'IFCWALL' } },
        { type: 'partOf', relation: 'IfcRelContainedInSpatialStructure', entity: { type: 'entity', name: { type: 'simpleValue', value: 'IFCBUILDINGSTOREY' } } },
      ] },
      requirements: [{ id: 'r', optionality: 'required', instructions: 'Record the rating from the fire strategy.', facet: {
        type: 'property', propertySet: { type: 'simpleValue', value: 'Pset_WallCommon' }, baseName: { type: 'simpleValue', value: 'FireRating' },
        dataType: { type: 'simpleValue', value: 'IFCLABEL' }, value: { type: 'enumeration', values: ['EI60', 'EI90'], base: 'xs:string' } } }],
    }] };
    const xml = writeIdsXml(doc);
    const reread = parseIDS(xml);
    // The XSD's relation token is upper case; the parser echoes it as `rawRelation` beside the normalised name.
    expect(reread.specifications[0].applicability.facets[1]).toMatchObject(doc.specifications[0].applicability.facets[1]);
    expect(reread.specifications[0].requirements[0].instructions).toBe('Record the rating from the fire strategy.');
    expect(reread.specifications[0].requirements[0].facet).toEqual(doc.specifications[0].requirements[0].facet);
    const audit = await auditIDSDocument(xml);
    expect(audit.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
    expect(() => writeIdsXml({ ...doc, specifications: [{ ...doc.specifications[0], requirements: [{ id: 'r', optionality: 'required',
      facet: { type: 'attribute', name: { type: 'simpleValue', value: 'Name' }, value: { type: 'bounds', maxLength: 4 } } }] }] }))
      .toThrow(/length or digit bounds are not supported/);
  });

  // #6915 review: attribute-value normalisation turns raw line breaks and tabs into spaces, and
  // XML 1.0 cannot carry other control characters at all.
  it('keeps line breaks and tabs in attributes, and refuses control characters by field', () => {
    const spec = (patch: Partial<IDSDocument['specifications'][number]>): IDSDocument => ({ info: { title: 'Whitespace' }, specifications: [{
      id: 's', name: 'Walls', ifcVersions: ['IFC4'], minOccurs: 1, maxOccurs: 'unbounded',
      applicability: { facets: [{ type: 'entity', name: { type: 'simpleValue', value: 'IFCWALL' } }] },
      requirements: [{ id: 'r', optionality: 'required', instructions: 'Line one\nLine two\r\n\tindented',
        facet: { type: 'attribute', name: { type: 'simpleValue', value: 'Name' } } }], ...patch }] });
    const reread = parseIDS(writeIdsXml(spec({ instructions: 'Check:\n1. names' })));
    expect(reread.specifications[0].instructions).toBe('Check:\n1. names');
    expect(reread.specifications[0].requirements[0].instructions).toBe('Line one\nLine two\r\n\tindented');
    expect(() => writeIdsXml(spec({ name: 'Walls\u0001' }))).toThrow(/specification "name" contains control character U\+0001/);
    expect(() => writeIdsXml({ ...spec({}), info: { title: 'T\u001b' } })).toThrow(/title contains control character U\+001B/);
  });
});
