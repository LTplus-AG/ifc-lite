/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #10542: a specification name or an IDS title that the author wrote is
 * not read as missing because it reads like the parser's fill-in text.
 *
 * `parseIDS` fills a missing `@name` with `Specification <n>` and a missing
 * `<title>` with `Untitled IDS`, and the audit used to treat those texts as
 * missing wherever they came from. The XSD types both as `xs:string`, so an
 * author may write them. These tests read the audit through
 * `auditIDSDocument` (XML) and `auditIDSStructure(parseIDS(xml))`. The
 * controls pin what stays as it was: a really missing or empty value is
 * still reported, `parseIDS` still returns the fill-in text, and a
 * document built in code is read as before.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { auditIDSDocument, auditIDSStructure } from '../index.js';
import { parseIDS } from '../../parser/xml-parser.js';
import type { IDSAuditIssue, IDSAuditReport } from '../types.js';
import type { IDSDocument } from '../../types.js';

const SPEC_BODY = `
      <applicability maxOccurs="unbounded">
        <entity><name><simpleValue>IFCWALL</simpleValue></name></entity>
      </applicability>
      <requirements>
        <attribute><name><simpleValue>Name</simpleValue></name></attribute>
      </requirements>`;

/** One `<specification>` per entry; each entry is the text of its attributes before `ifcVersion`. */
function ids(info: string, specNameAttrs: string[]): string {
  const specs = specNameAttrs
    .map((attrs) => `\n    <specification ${attrs} ifcVersion="IFC4">${SPEC_BODY}\n    </specification>`)
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<ids xmlns="http://standards.buildingsmart.org/IDS" xmlns:xs="http://www.w3.org/2001/XMLSchema">
  ${info}
  <specifications>${specs}
  </specifications>
</ids>`;
}

const TITLE = '<info><title>Walls</title></info>';

/** The issues that speak of a missing name or title, as `path: message`. */
function nameAndTitleIssues(report: IDSAuditReport): string[] {
  return report.issues
    .filter(
      (i: IDSAuditIssue) =>
        i.path === 'info.title' ||
        /^specifications\[\d+\]\.name$/.test(i.path) ||
        i.detail?.attribute === 'name'
    )
    .map((i) => `${i.severity} ${i.path}: ${i.message}`);
}

/** Both public entry points on the same XML. */
async function audits(xml: string): Promise<IDSAuditReport[]> {
  return [await auditIDSDocument(xml), await auditIDSStructure(parseIDS(xml))];
}

const MISSING_NAME = (i: number) => `error specifications[${i}].name: specification is missing a non-empty @name attribute`;
const MISSING_TITLE = 'warning info.title: IDS document is missing a non-empty <info><title> element';

describe('#10542: an authored name or title that reads like the parser fill-in text', () => {
  it('a specification named "Specification 3" by its author is valid', async () => {
    for (const report of await audits(ids(TITLE, ['name="Specification 3"']))) {
      expect(nameAndTitleIssues(report)).toEqual([]);
      expect(report.status).toBe('valid');
    }
  });

  it('an authored "Specification 2" in second place, the very text the parser fills there, is valid', async () => {
    for (const report of await audits(ids(TITLE, ['name="Walls"', 'name="Specification 2"']))) {
      expect(nameAndTitleIssues(report)).toEqual([]);
      expect(report.status).toBe('valid');
    }
  });

  it('an IDS whose author wrote <title>Untitled IDS</title> has no title warning', async () => {
    for (const report of await audits(ids('<info><title>Untitled IDS</title></info>', ['name="Walls"']))) {
      expect(nameAndTitleIssues(report)).toEqual([]);
      expect(report.status).toBe('valid');
    }
  });

  it('the committed sample IDS audits the same with its names and title replaced by the fill-in texts', async () => {
    const sample = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../../../../../apps/viewer/public/samples/building-architecture.ids'),
      'utf8'
    );
    let n = 0;
    const renamed = sample
      .replace(/<title>[^<]*<\/title>/, '<title>Untitled IDS</title>')
      .replace(/<specification name="[^"]*"/g, () => `<specification name="Specification ${++n}"`);
    expect(n).toBe(3);

    const strip = (r: IDSAuditReport) => ({ status: r.status, issues: r.issues });
    expect(strip(await auditIDSDocument(renamed))).toEqual(strip(await auditIDSDocument(sample)));
    expect(strip(await auditIDSStructure(parseIDS(renamed)))).toEqual(strip(await auditIDSStructure(parseIDS(sample))));
  });
});

describe('#10542 controls: missing values, parseIDS and documents built in code stay as they were', () => {
  it('a specification with no @name is still reported, by both entry points', async () => {
    const [fromXml, fromDoc] = await audits(ids(TITLE, ['name="Walls"', '']));
    expect(nameAndTitleIssues(fromXml)).toEqual([
      'error ids.specifications.specification[1]: <specification> is missing required @name',
      MISSING_NAME(1),
    ]);
    expect(nameAndTitleIssues(fromDoc)).toEqual([MISSING_NAME(1)]);
  });

  it('an empty or blank @name is still reported', async () => {
    for (const attr of ['name=""', 'name="   "']) {
      for (const report of await audits(ids(TITLE, [attr]))) {
        expect(nameAndTitleIssues(report)).toEqual([MISSING_NAME(0)]);
      }
    }
  });

  it('a missing, empty or blank <title>, and a missing <info>, still warn', async () => {
    for (const info of ['<info><version>1</version></info>', '<info><title></title></info>', '<info><title>  </title></info>', '']) {
      for (const report of await audits(ids(info, ['name="Walls"']))) {
        expect(nameAndTitleIssues(report)).toContain(MISSING_TITLE);
      }
    }
  });

  it('parseIDS still returns the fill-in texts for a missing name and title', () => {
    const doc = parseIDS(ids('<info><version>1</version></info>', ['name="Walls"', '', 'name=""']));
    expect(doc.info.title).toBe('Untitled IDS');
    expect(doc.specifications.map((s) => s.name)).toEqual(['Walls', 'Specification 2', 'Specification 3']);
    expect(Object.keys(doc.specifications[1]).sort()).toEqual(Object.keys(doc.specifications[0]).sort());
    expect(Object.keys(doc.info).sort()).toEqual(Object.keys(parseIDS(ids(TITLE, ['name="Walls"'])).info).sort());
  });

  it('a document built in code still has "Specification 3" and "Untitled IDS" read as missing', async () => {
    const parsed = parseIDS(ids(TITLE, ['name="Walls"']));
    const built: IDSDocument = {
      info: { title: 'Untitled IDS' },
      specifications: [{ ...parsed.specifications[0], name: 'Specification 3' }],
    };
    expect(nameAndTitleIssues(await auditIDSStructure(built))).toEqual([MISSING_TITLE, MISSING_NAME(0)]);
  });

  it('a copy of a parsed document is read like a document built in code', async () => {
    const copy = structuredClone(parseIDS(ids('<info><title>Untitled IDS</title></info>', ['name="Specification 3"'])));
    expect(nameAndTitleIssues(await auditIDSStructure(copy))).toEqual([MISSING_TITLE, MISSING_NAME(0)]);
  });

  it('editing a parsed name and title to the fill-in labels does not mark those values as authored in XML', async () => {
    const doc = parseIDS(ids(TITLE, ['name="Walls"']));
    doc.info.title = 'Untitled IDS';
    doc.specifications[0].name = 'Specification 3';
    expect(nameAndTitleIssues(await auditIDSStructure(doc))).toEqual([MISSING_TITLE, MISSING_NAME(0)]);
  });

  it('a parsed name or title changed in place to an empty one is reported', async () => {
    const doc = parseIDS(ids(TITLE, ['name="Specification 3"']));
    doc.info.title = ' ';
    doc.specifications[0].name = '';
    expect(nameAndTitleIssues(await auditIDSStructure(doc))).toEqual([MISSING_TITLE, MISSING_NAME(0)]);
  });
});
