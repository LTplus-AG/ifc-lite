/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The minimal semantic diff behind `ifc-lite ids diff` and MCP `ids_diff`
 * (IDS-116, IDS-119). Oracle: each case edits one thing in a known
 * document, so the diff must report exactly that edit and nothing else.
 */

import { parseIDS, type IDSDocument } from '@ifc-lite/ids';
import { describe, expect, it } from 'vitest';
import { loadCorpus } from '../../test/corpus.js';
import { diffIds } from './diff.js';

const BASE = `<?xml version="1.0" encoding="UTF-8"?>
<ids xmlns="http://standards.buildingsmart.org/IDS" xmlns:xs="http://www.w3.org/2001/XMLSchema">
<info><title>Doors</title></info>
<specifications>
<specification name="Fire doors" ifcVersion="IFC4">
<applicability minOccurs="0" maxOccurs="unbounded"><entity><name><simpleValue>IFCDOOR</simpleValue></name></entity></applicability>
<requirements>
<property cardinality="required"><propertySet><simpleValue>Pset_DoorCommon</simpleValue></propertySet><baseName><simpleValue>FireRating</simpleValue></baseName></property>
<attribute cardinality="optional"><name><simpleValue>Name</simpleValue></name></attribute>
</requirements>
</specification>
<specification name="Walls named" ifcVersion="IFC4">
<applicability minOccurs="0" maxOccurs="unbounded"><entity><name><simpleValue>IFCWALL</simpleValue></name></entity></applicability>
<requirements><attribute cardinality="required"><name><simpleValue>Name</simpleValue></name></attribute></requirements>
</specification>
</specifications>
</ids>`;

const base = (): IDSDocument => parseIDS(BASE);
const edit = (from: string, to: string): IDSDocument => {
  if (!BASE.includes(from)) throw new Error(`fixture does not contain ${from}`);
  return parseIDS(BASE.replace(from, to));
};

describe('diffIds', () => {
  it('reports nothing for the same document', () => {
    expect(diffIds(base(), base())).toMatchObject({ identical: true, entries: [] });
  });

  it('reports nothing for every corpus document against itself', () => {
    for (const { name, ids } of loadCorpus()) expect(diffIds(ids, ids).entries, name).toEqual([]);
  });

  it('reports a rename as one change, not a remove plus an add', () => {
    const diff = diffIds(base(), edit('name="Fire doors"', 'name="Fire-rated doors"'));
    expect(diff.entries).toEqual([
      expect.objectContaining({ change: 'changed', node: 'spec', field: 'name', before: 'Fire doors', after: 'Fire-rated doors' }),
    ]);
  });

  it('reports an optionality change on the requirement it belongs to', () => {
    const diff = diffIds(base(), edit('<attribute cardinality="optional">', '<attribute cardinality="required">'));
    expect(diff.entries).toEqual([
      expect.objectContaining({ change: 'changed', field: 'optionality', before: 'optional', after: 'required', path: 'specifications[0].requirements[1]' }),
    ]);
  });

  it('reports a changed property name as a changed facet with both readings', () => {
    const diff = diffIds(base(), edit('FireRating', 'AcousticRating'));
    expect(diff.entries).toHaveLength(1);
    expect(diff.entries[0]).toMatchObject({ change: 'changed', field: 'facet', path: 'specifications[0].requirements[0]' });
    expect(diff.entries[0].before).toContain('FireRating');
    expect(diff.entries[0].after).toContain('AcousticRating');
  });

  it('reports added and removed specifications and facets', () => {
    const removedSpec = parseIDS(BASE.replace(/<specification name="Walls named"[\s\S]*?<\/specification>/, ''));
    expect(diffIds(base(), removedSpec).entries).toEqual([expect.objectContaining({ change: 'removed', node: 'spec', spec: 'Walls named' })]);
    expect(diffIds(removedSpec, base()).entries).toEqual([expect.objectContaining({ change: 'added', node: 'spec', spec: 'Walls named' })]);
    const noName = edit('<attribute cardinality="optional"><name><simpleValue>Name</simpleValue></name></attribute>', '');
    expect(diffIds(base(), noName).entries).toEqual([
      expect.objectContaining({ change: 'removed', node: 'facet', path: 'specifications[0].requirements[1]' }),
    ]);
  });

  it('reports document info and cardinality changes', () => {
    const diff = diffIds(base(), edit('<title>Doors</title>', '<title>Doors v2</title>'));
    expect(diff.entries).toEqual([expect.objectContaining({ node: 'info', field: 'title', before: 'Doors', after: 'Doors v2' })]);
    const required = diffIds(base(), edit('minOccurs="0" maxOccurs="unbounded"><entity><name><simpleValue>IFCWALL', 'minOccurs="1" maxOccurs="unbounded"><entity><name><simpleValue>IFCWALL'));
    expect(required.entries).toEqual([expect.objectContaining({ spec: 'Walls named', field: 'cardinality', before: 'optional', after: 'required' })]);
  });
});
