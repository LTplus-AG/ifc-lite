/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { parseIDS } from '@ifc-lite/ids';
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { loadCorpus } from '../../test/corpus.js';
import { fromIdsDocument } from '../document/from-ids.js';
import { readIdsz, writeIdsz } from './idsz.js';
import { attachSidecar, createSidecar, parseSidecar, serializeSidecar } from './sidecar.js';

const { xml } = loadCorpus().find((entry) => entry.ids.specifications.length > 0)!;
const doc = fromIdsDocument(parseIDS(xml));
const valid = createSidecar(doc, xml);
const id = doc.docId;

describe('#7168 IDS-025 sidecar shape at every import boundary', () => {
  const invalid: [string, unknown][] = [
    ['missing node specification array', { ...valid, nodes: {} }],
    ['invalid document UUID', { ...valid, docId: 'not-a-uuid' }],
    ['invalid indexed document UUID', { ...valid, nodes: { ...valid.nodes, document: 7 } }],
    ['non-array specification index', { ...valid, nodes: { ...valid.nodes, specs: {} } }],
    ['missing facet arrays', { ...valid, nodes: { ...valid.nodes, specs: [{ id }] } }],
    ['invalid constraint UUID', { ...valid, nodes: { ...valid.nodes, specs: [{
      id, applicability: [{ id, constraints: { 'entity.name': 'bad' } }], requirements: [],
    }] } }],
    ['missing metadata collections', { ...valid, meta: {} }],
    ['non-array provenance', { ...valid, meta: { ...valid.meta, provenance: { [id]: {} } } }],
    ['incomplete AI provenance', { ...valid, meta: { ...valid.meta, provenance: { [id]: [{ by: 'ai', at: '', opId: id }] } } }],
    ['invalid source page', { ...valid, meta: { ...valid.meta, sources: { [id]: [{ docRef: '', kind: 'text', quote: '', page: 'first' }] } } }],
    ['missing source quote', { ...valid, meta: { ...valid.meta, sources: { [id]: [{ docRef: '', kind: 'text' }] } } }],
    ['invalid comment resolution', { ...valid, meta: { ...valid.meta, comments: { [id]: [{ id, resolved: 'yes', comments: [] }] } } }],
    ['invalid nested comment', { ...valid, meta: { ...valid.meta, comments: { [id]: [{ id, resolved: false, comments: [{ text: 7 }] }] } } }],
    ['incomplete suppression', { ...valid, meta: { ...valid.meta, suppressions: { [id]: [{ rule: 'ENT-001' }] } } }],
    ['non-record test collection', { ...valid, meta: { ...valid.meta, tests: [] } }],
    ['non-array mappings', { ...valid, meta: { ...valid.meta, mappings: {} } }],
    ['non-array unresolved collection', { ...valid, meta: { ...valid.meta, unresolved: {} } }],
    ['invalid sign-off', { ...valid, meta: { ...valid.meta, revision: { signOffs: [{ by: 7, at: '' }] } } }],
    ['non-array custom declarations', { ...valid, meta: { ...valid.meta, custom: { psets: {}, userDefinedTypes: [] } } }],
    ['invalid custom property', { ...valid, meta: { ...valid.meta, custom: { psets: [{ name: 'Example', properties: [{ name: 7 }] }], userDefinedTypes: [] } } }],
    ['invalid user-defined type', { ...valid, meta: { ...valid.meta, custom: { psets: [], userDefinedTypes: [{ entity: 'IfcWall', value: false }] } } }],
  ];

  it.each(invalid)('refuses %s before direct or bundled import', (_name, value) => {
    const json = JSON.stringify(value);
    expect(() => parseSidecar(json)).toThrow(/IDS Studio sidecar.*\$/);
    const bytes = zipSync({ 'ids.xml': strToU8(xml), 'studio.json': strToU8(json) });
    expect(() => readIdsz(bytes)).toThrow(/IDS Studio sidecar.*\$/);
  });

  it('preserves valid nested metadata and opaque later-pitch payloads through bundle and attachment', () => {
    const sidecar = {
      ...valid,
      extension: { future: true },
      meta: {
        ...valid.meta,
        provenance: { [id]: [{ by: 'user' as const, at: '', opId: id }] },
        sources: { [id]: [{ docRef: '', kind: 'text' as const, quote: 'Walls have ratings' }] },
        comments: { [id]: [{ id, resolved: false, comments: [{ author: '', at: '', text: 'Review' }] }] },
        suppressions: { [id]: [{ rule: 'ENT-001', reason: 'Reviewed', at: '' }] },
        tests: { [id]: { laterPitch: [1, null, { nested: true }] } },
        mappings: [{ laterPitch: true }], unresolved: [null, { statement: 'Review' }],
        revision: { signOffs: [{ by: '', at: '' }] },
        custom: { psets: [{ name: 'Example', properties: [{ name: 'Rating', dataType: 'IFCLABEL' }] }],
          userDefinedTypes: [{ entity: 'IfcWall', value: 'Example' }] },
        extension: { preserved: true },
      },
    };
    expect(parseSidecar(serializeSidecar(sidecar))).toEqual(sidecar);
    const bundle = readIdsz(writeIdsz({ xml, sidecar }));
    expect(bundle.sidecar).toEqual(sidecar);
    const attached = attachSidecar(parseIDS(bundle.xml), bundle.sidecar!);
    expect(attached.binding).toBe('exact');
    expect(attached.doc.nodes).toEqual(doc.nodes);
    expect(attached.doc.meta).toEqual(sidecar.meta);
  });
});
