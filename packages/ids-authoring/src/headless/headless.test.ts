/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Headless read / write / format (IDS-115, IDS-118).
 *
 * The oracle for `writeIdsChecked` is the parser: whatever XML comes out
 * must read back with every value the input defined. The writer under
 * test is the one this build ships (`writeIdsXml` from `@ifc-lite/rules`),
 * so the corpus run also records which corpus documents it cannot carry.
 */

import { parseIDS, type IDSDocument } from '@ifc-lite/ids';
import { writeIdsXml } from '@ifc-lite/rules';
import { describe, expect, it } from 'vitest';
import { loadCorpus } from '../../test/corpus.js';
import { nodePath } from './node-path.js';
import { parseStudioDocument, readStudioDocument } from './read.js';
import { formatIds, lostPaths, writeIdsChecked, writeStudioDocument } from './write.js';

const DOORS = `<?xml version="1.0" encoding="UTF-8"?>
<ids xmlns="http://standards.buildingsmart.org/IDS" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://standards.buildingsmart.org/IDS http://standards.buildingsmart.org/IDS/1.0/ids.xsd">
<info><title>Doors</title></info>
<specifications>
<specification name="Fire doors" ifcVersion="IFC4">
<applicability minOccurs="0" maxOccurs="unbounded"><entity><name><simpleValue>IFCDOOR</simpleValue></name></entity></applicability>
<requirements><property cardinality="required"><propertySet><simpleValue>Pset_DoorCommon</simpleValue></propertySet><baseName><simpleValue>FireRating</simpleValue></baseName></property></requirements>
</specification>
</specifications>
</ids>
`;

describe('readStudioDocument', () => {
  it('gives the same node ids every time the same XML is read', () => {
    const a = readStudioDocument(DOORS);
    const b = readStudioDocument(DOORS);
    expect(b.nodes).toEqual(a.nodes);
    expect(b.docId).toBe(a.docId);
  });

  it('gives different ids to different content', () => {
    const a = readStudioDocument(DOORS);
    const b = readStudioDocument(DOORS.replace('Fire doors', 'Exit doors'));
    expect(b.nodes.specs[0].id).not.toBe(a.nodes.specs[0].id);
  });

  it('names nodes by an XML path', () => {
    const doc = readStudioDocument(DOORS);
    const req = doc.nodes.specs[0].requirements[0];
    expect(nodePath(doc, doc.nodes.document)).toBe('info');
    expect(nodePath(doc, doc.nodes.specs[0].id)).toBe('specifications[0]');
    expect(nodePath(doc, doc.nodes.specs[0].applicability[0].id)).toBe('specifications[0].applicability[0]');
    expect(nodePath(doc, req.id)).toBe('specifications[0].requirements[0]');
    expect(nodePath(doc, req.constraints['property.baseName']!)).toBe('specifications[0].requirements[0].baseName');
    expect(nodePath(doc, '00000000-0000-7000-8000-000000000000')).toBeUndefined();
  });
});

describe('parseStudioDocument', () => {
  it('accepts a document that went through JSON', () => {
    const doc = readStudioDocument(DOORS);
    expect(parseStudioDocument(JSON.parse(JSON.stringify(doc)))).toEqual(doc);
  });

  it.each([
    ['not an object', () => 42, /JSON object/],
    ['a wrong schema version', (d: Record<string, unknown>) => ({ ...d, schemaVersion: 2 }), /schemaVersion/],
    ['a non-UUID docId', (d: Record<string, unknown>) => ({ ...d, docId: 'x' }), /docId/],
    ['no specifications', (d: Record<string, unknown>) => ({ ...d, ids: { info: {} } }), /specifications/],
    ['no meta', (d: Record<string, unknown>) => ({ ...d, meta: null }), /meta/],
  ])('refuses %s', (_label, mutate, pattern) => {
    const doc = JSON.parse(JSON.stringify(readStudioDocument(DOORS))) as Record<string, unknown>;
    expect(() => parseStudioDocument(mutate(doc))).toThrow(pattern);
  });

  it('refuses a node index that does not match the content', () => {
    const doc = JSON.parse(JSON.stringify(readStudioDocument(DOORS)));
    doc.nodes.specs[0].requirements = [];
    expect(() => parseStudioDocument(doc)).toThrow(/inconsistent node index/);
  });

  it('refuses a facet without a type', () => {
    const doc = JSON.parse(JSON.stringify(readStudioDocument(DOORS)));
    doc.ids.specifications[0].requirements[0].facet = { name: 'x' };
    expect(() => parseStudioDocument(doc)).toThrow(/facet without a type/);
  });
});

describe('lostPaths', () => {
  it('ignores defaults only the written side has, and node ids', () => {
    expect(lostPaths({ a: 1, id: 'x' }, { a: 1, b: 2, id: 'y' })).toEqual([]);
  });

  it('reports values that changed or disappeared', () => {
    expect(lostPaths({ info: { title: 't', author: 'a@b.c' }, list: [1, 2] }, { info: { title: 't' }, list: [1] })).toEqual([
      'info.author',
      'list[1]',
    ]);
  });
});

describe('writeIdsChecked', () => {
  it('writes a document the writer can carry', () => {
    const out = writeStudioDocument(readStudioDocument(DOORS), writeIdsXml);
    expect(out.ok).toBe(true);
    if (out.ok) expect(parseIDS(out.xml).specifications[0].name).toBe('Fire doors');
  });

  it('reports the info fields this build of the writer drops instead of writing without them', () => {
    const ids: IDSDocument = { ...parseIDS(DOORS), info: { title: 'Doors', author: 'someone@example.com', version: '2' } };
    const out = writeIdsChecked(ids, writeIdsXml);
    expect(out).toMatchObject({ ok: false, reason: 'lossy', lost: ['info.author', 'info.version'] });
  });

  it('passes a writer refusal through with its reason', () => {
    const out = writeIdsChecked(parseIDS(DOORS), () => {
      throw new Error('cannot write this');
    });
    expect(out).toEqual({ ok: false, reason: 'refused', message: 'cannot write this' });
  });

  it('never returns XML that reads back with less content, across the corpus', () => {
    let written = 0;
    for (const { name, ids } of loadCorpus()) {
      const out = writeIdsChecked(ids, writeIdsXml);
      if (out.ok) {
        written++;
        expect(lostPaths(ids, parseIDS(out.xml)), name).toEqual([]);
      } else {
        expect(['refused', 'lossy'], name).toContain(out.reason);
      }
    }
    // Most of the corpus is within what the current writer carries.
    expect(written).toBeGreaterThan(200);
  });
});

describe('formatIds', () => {
  it('is idempotent: formatting canonical output changes nothing', () => {
    const first = formatIds(DOORS, writeIdsXml);
    expect(first).toMatchObject({ ok: true, changed: true });
    if (!first.ok) return;
    expect(formatIds(first.xml, writeIdsXml)).toEqual({ ok: true, xml: first.xml, changed: false });
  });

  it('treats CRLF line endings as unchanged', () => {
    const first = formatIds(DOORS, writeIdsXml);
    if (!first.ok) throw new Error('expected ok');
    expect(formatIds(first.xml.replace(/\n/g, '\r\n'), writeIdsXml)).toMatchObject({ ok: true, changed: false });
  });

  it('reports a parse failure', () => {
    expect(formatIds('<ids', writeIdsXml)).toMatchObject({ ok: false, reason: 'parse' });
  });
});
