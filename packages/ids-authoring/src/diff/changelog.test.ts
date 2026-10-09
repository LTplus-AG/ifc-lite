/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Plain-language changelog (IDS-104): every change explained, in each locale. */

import type { SupportedLocale } from '@ifc-lite/ids';
import { describe, expect, it } from 'vitest';
import { counterIds } from '../../test/corpus.js';
import { corpusDocument, mutate } from '../../test/mutate.js';
import { seeded } from '../../test/op-gen.js';
import { createStudioDocument } from '../document/from-ids.js';
import type { PrimitiveOp, StudioOp } from '../ops/types.js';
import { apply } from '../reducer/apply.js';
import { changelog, changelogMarkdown, diffDocuments } from './index.js';

const ids = counterIds(0xc4a);
const op = <K extends PrimitiveOp['kind']>(kind: K, payload: Extract<PrimitiveOp, { kind: K }>['payload']): StudioOp =>
  ({ kind, opId: ids(), payload }) as StudioOp;

function doorsDocument() {
  const specId = ids();
  const reqId = ids();
  const doc = apply(createStudioDocument({ title: 'Fire safety', newId: ids }), [
    op('spec.add', { specId, name: 'Doors', ifcVersions: ['IFC4'] }),
    op('facet.add', { specId, section: 'applicability', facetId: ids(), facet: { type: 'entity', name: { kind: 'equals', value: 'IfcDoor' } } }),
    op('facet.add', {
      specId,
      section: 'requirements',
      facetId: reqId,
      optionality: 'optional',
      facet: { type: 'property', propertySet: { kind: 'equals', value: 'Pset_DoorCommon' }, baseName: { kind: 'equals', value: 'FireRating' } },
    }),
  ]).doc;
  return { doc, specId, reqId };
}

describe('changelog', () => {
  it('explains a requirement that became required (architecture §6 example)', () => {
    const { doc, reqId } = doorsDocument();
    const next = apply(doc, [op('requirement.setOptionality', { facetId: reqId, optionality: 'required' })]).doc;
    const lines = changelog(diffDocuments(doc, next));
    expect(lines.map((l) => l.text)).toEqual(['Doors: FireRating (Pset_DoorCommon) changed from optional to required']);
  });

  it('renders value, cardinality and rename changes', () => {
    const { doc, specId, reqId } = doorsDocument();
    const next = apply(doc, [
      op('facet.setField', { facetId: reqId, field: 'property.value', value: { kind: 'oneOf', values: ['EI30', 'EI60'] } }),
      op('spec.setCardinality', { specId, cardinality: 'optional' }),
      op('spec.set', { specId, field: 'name', value: 'Fire doors' }),
    ]).doc;
    const texts = changelog(diffDocuments(doc, next)).map((l) => l.text);
    expect(texts).toContain('Specification "Doors" renamed to "Fire doors"');
    expect(texts).toContain('Specification "Fire doors" changed from required to optional');
    expect(texts.find((t) => t.startsWith('Fire doors: FireRating (Pset_DoorCommon) set to'))).toBeDefined();
    expect(texts.filter((t) => t.includes('changed from required to optional'))).toHaveLength(1);
  });

  it('gives every change of 300 corpus revisions a sentence in en, de and fr', () => {
    const locales: SupportedLocale[] = ['en', 'de', 'fr'];
    let lines = 0;
    for (let seq = 0; seq < 300; seq++) {
      const a = corpusDocument(seq);
      const { doc: b } = mutate(seeded(0xbeef + seq), a, 1 + (seq % 5), counterIds(0xb00 + seq));
      const diff = diffDocuments(a, b);
      for (const locale of locales) {
        const out = changelog(diff, { locale });
        // Only the min/max occurrence pair may fold into one sentence.
        const folded = diff.entries.filter((e) => e.kind === 'spec.changed' && e.cardinality && e.cardinality.old !== e.cardinality.new).length;
        expect(out.length).toBeGreaterThanOrEqual(diff.entries.length - folded);
        for (const line of out) {
          expect(line.text.trim().length).toBeGreaterThan(8);
          expect(line.text).not.toMatch(/undefined|\[object|NaN/);
        }
        lines += out.length;
      }
    }
    expect(lines).toBeGreaterThan(1000);
  }, 60_000);

  it('groups the Markdown changelog by specification', () => {
    const { doc, reqId } = doorsDocument();
    const next = apply(doc, [
      op('doc.setInfo', { field: 'version', value: '2.0' }),
      op('requirement.setOptionality', { facetId: reqId, optionality: 'required' }),
    ]).doc;
    expect(changelogMarkdown(diffDocuments(doc, next), { title: 'v1 → v2' })).toBe(
      ['# v1 → v2', '', '- Version set to "2.0"', '', '## Doors', '', '- Doors: FireRating (Pset_DoorCommon) changed from optional to required', ''].join('\n'),
    );
    expect(changelogMarkdown(diffDocuments(doc, doc))).toBe('# Changes\n\n');
  });

  it('speaks German and French', () => {
    const { doc, reqId } = doorsDocument();
    const next = apply(doc, [op('requirement.setOptionality', { facetId: reqId, optionality: 'required' })]).doc;
    const diff = diffDocuments(doc, next);
    expect(changelog(diff, { locale: 'de' })[0].text).toBe('Doors: FireRating (Pset_DoorCommon) geändert von optional zu erforderlich');
    expect(changelog(diff, { locale: 'fr' })[0].text).toBe('Doors: FireRating (Pset_DoorCommon) modifié de facultatif à obligatoire');
  });
});
