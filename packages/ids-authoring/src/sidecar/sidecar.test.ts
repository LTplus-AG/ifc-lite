/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { parseIDS } from '@ifc-lite/ids';
import { describe, expect, it } from 'vitest';
import { loadCorpus } from '../../test/corpus.js';
import { fromIdsDocument } from '../document/from-ids.js';
import { readIdsz, writeIdsz } from './idsz.js';
import { attachSidecar, createSidecar, fingerprintIds, parseSidecar, serializeSidecar } from './sidecar.js';

const corpus = loadCorpus();

describe('studio.json sidecar', () => {
  it('round-trips node ids and meta exactly for every corpus document', () => {
    for (const { name, xml } of corpus) {
      const doc = fromIdsDocument(parseIDS(xml));
      doc.meta.comments[doc.nodes.specs[0]?.id ?? doc.nodes.document] = [
        { id: doc.docId, resolved: false, comments: [{ author: 'a@example.com', at: '2026-10-08T00:00:00Z', text: 'check this' }] },
      ];
      const json = serializeSidecar(createSidecar(doc, xml));
      const { doc: back, binding } = attachSidecar(parseIDS(xml), parseSidecar(json));
      expect(binding, name).toBe('exact');
      expect(back, name).toEqual(doc);
    }
  });

  it('keeps docId and meta but mints fresh ids when the XML changed elsewhere', () => {
    const { xml } = corpus.find((c) => c.ids.specifications.length > 0)!;
    const doc = fromIdsDocument(parseIDS(xml));
    const sidecar = createSidecar(doc, xml);
    const edited = parseIDS(xml.replace(/name="([^"]*)"/, 'name="$1 (rev B)"'));
    expect(fingerprintIds(edited)).not.toBe(sidecar.idsFingerprint);
    const { doc: back, binding } = attachSidecar(edited, sidecar);
    expect(binding).toBe('fresh');
    expect(back.docId).toBe(doc.docId);
    expect(back.meta).toBe(sidecar.meta);
    expect(back.nodes.specs[0].id).not.toBe(doc.nodes.specs[0].id);
  });

  it('fingerprints content, not ids or key order', () => {
    const { ids } = corpus[0];
    const a = fromIdsDocument(ids).ids;
    const b = fromIdsDocument(ids).ids;
    expect(a.specifications[0]?.id).not.toBe(b.specifications[0]?.id);
    expect(fingerprintIds(a)).toBe(fingerprintIds(b));
    expect(fingerprintIds({ ...a, info: { ...a.info, title: `${a.info.title}!` } })).not.toBe(fingerprintIds(a));
  });

  it('refuses foreign or newer sidecars', () => {
    expect(() => parseSidecar('{"format":"other"}')).toThrow(/not an IDS Studio sidecar/);
    const doc = fromIdsDocument(corpus[0].ids);
    const s = JSON.parse(serializeSidecar(createSidecar(doc))) as Record<string, unknown>;
    expect(() => parseSidecar(JSON.stringify({ ...s, schemaVersion: 2 }))).toThrow(/unsupported/);
  });
});

describe('.idsz bundle', () => {
  const { xml } = corpus.find((c) => c.ids.specifications.length > 0)!;
  const doc = fromIdsDocument(parseIDS(xml));
  const fixture = new TextEncoder().encode('ISO-10303-21;\nEND-ISO-10303-21;\n');

  it('carries the XML byte-identical with and without the sidecar', () => {
    const withSidecar = readIdsz(writeIdsz({ xml, sidecar: createSidecar(doc, xml), fixtures: { 'wall.ifc': fixture } }));
    const without = readIdsz(writeIdsz({ xml }));
    const bytes = (s: string) => Array.from(new TextEncoder().encode(s));
    expect(bytes(withSidecar.xml)).toEqual(bytes(xml));
    expect(bytes(without.xml)).toEqual(bytes(xml));
    expect(without.sidecar).toBeUndefined();
    expect(withSidecar.fixtures?.['wall.ifc']).toEqual(fixture);
    const { doc: back, binding } = attachSidecar(parseIDS(withSidecar.xml), withSidecar.sidecar!);
    expect(binding).toBe('exact');
    expect(back).toEqual(doc);
  });

  it('is deterministic and refuses bundles without ids.xml or with unsafe fixture names', () => {
    const a = writeIdsz({ xml, sidecar: createSidecar(doc, xml) });
    const b = writeIdsz({ xml, sidecar: createSidecar(doc, xml) });
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(() => writeIdsz({ xml, fixtures: { '../evil.ifc': fixture } })).toThrow(/invalid fixture name/);
    expect(() => readIdsz(writeIdsz({ xml }).slice(0, 0))).toThrow();
  });
});
