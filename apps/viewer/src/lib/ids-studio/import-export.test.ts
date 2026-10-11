/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** IDS-040: what Studio saves, Studio opens again, and a bundle keeps its node ids. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createStudioDocument } from '@ifc-lite/ids-authoring';
import { wallFixture } from '@/test/ids-studio-fixture';
import { exportIds, exportIdsz, studioFileName } from './export';
import { importIdsXml, importIdsz, importStudioFile } from './import';

describe('Studio import/export (IDS-040)', () => {
  it('round-trips an .ids file to the same IDS content', async () => {
    const { doc } = await wallFixture();
    const saved = exportIds(doc);
    assert.ok(saved.ok);
    if (!saved.ok) return;
    assert.equal(saved.fileName, 'Fire-safety.ids');
    const opened = importIdsXml(saved.content);
    assert.ok(opened.ok);
    if (!opened.ok) return;
    assert.equal(opened.format, 'ids');
    const again = exportIds(opened.doc);
    assert.equal(again.ok && again.content, saved.content, 'saving the opened file writes the same XML');
    assert.equal(opened.doc.ids.specifications[0].name, 'Walls – fire rating');
  });

  it('round-trips an .idsz bundle with the exact node ids', async () => {
    const { doc, specId, propertyId } = await wallFixture();
    const saved = exportIdsz(doc);
    assert.ok(saved.ok);
    if (!saved.ok) return;
    assert.equal(saved.fileName, 'Fire-safety.idsz');
    const opened = importIdsz(saved.content);
    assert.ok(opened.ok);
    if (!opened.ok) return;
    assert.equal(opened.format, 'idsz');
    assert.equal(opened.binding, 'exact');
    assert.equal(opened.doc.docId, doc.docId);
    assert.equal(opened.doc.nodes.specs[0].id, specId);
    assert.equal(opened.doc.nodes.specs[0].requirements[0].id, propertyId);
  });

  it('opens a dropped file by its extension', async () => {
    const { doc } = await wallFixture();
    const xml = exportIds(doc);
    const bundle = exportIdsz(doc);
    assert.ok(xml.ok && bundle.ok);
    if (!xml.ok || !bundle.ok) return;
    const fromXml = await importStudioFile(new File([xml.content], 'a.ids'));
    const fromBundle = await importStudioFile(new File([new Uint8Array(bundle.content)], 'a.IDSZ'));
    assert.equal(fromXml.ok && fromXml.format, 'ids');
    assert.equal(fromBundle.ok && fromBundle.format, 'idsz');
  });

  it('reports a malformed file instead of throwing', () => {
    const xml = importIdsXml('<not-ids');
    assert.equal(xml.ok, false);
    const bundle = importIdsz(new Uint8Array([1, 2, 3]));
    assert.equal(bundle.ok, false);
  });

  it('derives a safe file name and falls back when the title has none', () => {
    assert.equal(studioFileName(createStudioDocument({ title: 'Tür / Fenster: Brandschutz' }), 'ids'), 'Tur-Fenster-Brandschutz.ids');
    assert.equal(studioFileName(createStudioDocument({ title: '///' }), 'idsz'), 'ids.idsz');
  });
});
