/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `bim.ids.authoring` (IDS-120): a script edits IDS only through grounded
 * ops. Refused batches change nothing and say why; accepted ones undo.
 */

import { describe, expect, it } from 'vitest';
import { IDSNamespace } from './ids.js';

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<ids xmlns="http://standards.buildingsmart.org/IDS" xmlns:xs="http://www.w3.org/2001/XMLSchema">
<info><title>Doors</title></info>
<specifications>
<specification name="Fire doors" ifcVersion="IFC4">
<applicability minOccurs="0" maxOccurs="unbounded"><entity><name><simpleValue>IFCDOOR</simpleValue></name></entity></applicability>
</specification>
</specifications>
</ids>`;

const bim = { ids: new IDSNamespace() };

function requirement(specId: string, property: string) {
  return {
    kind: 'facet.add',
    opId: '00000000-0000-7000-8000-0000000000a1',
    payload: {
      specId,
      section: 'requirements',
      facetId: '00000000-0000-7000-8000-000000000003',
      facet: { type: 'property', propertySet: { kind: 'equals', value: 'Pset_DoorCommon' }, baseName: { kind: 'equals', value: property } },
    },
  };
}

describe('bim.ids.authoring', () => {
  it('refuses a hallucinated name, keeps the document, and returns candidates', async () => {
    const doc = await bim.ids.authoring.open(XML);
    const before = doc.doc;
    const res = doc.apply([requirement(before.nodes.specs[0].id, 'FireRatingValue')]);
    expect(res.ok).toBe(false);
    expect(res.applied).toBe(0);
    expect(res.errors[0]).toMatchObject({ code: 'GATE-PROP-001' });
    expect(res.errors[0].candidates.map((c) => c.value)).toContain('FireRating');
    expect(doc.doc).toBe(before);
    expect(doc.undo()).toBe(false);
  });

  it('applies a grounded batch, lints, writes, and undoes it', async () => {
    const doc = await bim.ids.authoring.open(XML);
    const specId = doc.doc.nodes.specs[0].id;
    expect(doc.apply([requirement(specId, 'FireRating')])).toEqual({ ok: true, applied: 1, errors: [] });
    expect(doc.lint({ rules: ['IDSL-PROP-001'] })).toEqual([]);
    const xml = doc.write();
    expect(xml).toContain('<simpleValue>FireRating</simpleValue>');
    expect(doc.pathOf('00000000-0000-7000-8000-000000000003')).toBe('specifications[0].requirements[0]');
    expect(doc.undo()).toBe(true);
    expect(doc.doc.ids.specifications[0].requirements).toEqual([]);
    expect(doc.redo()).toBe(true);
    expect(doc.doc.ids.specifications[0].requirements).toHaveLength(1);
  });

  it('starts an empty document', async () => {
    const doc = await bim.ids.authoring.create('Walls');
    expect(doc.doc.ids.info.title).toBe('Walls');
    expect(doc.doc.ids.specifications).toEqual([]);
  });

  it('throws instead of writing XML that loses content', async () => {
    const doc = await bim.ids.authoring.open(XML.replace('<title>Doors</title>', '<title>Doors</title><author>someone@example.com</author>'));
    expect(() => doc.write()).toThrow(/info\.author/);
  });
});
