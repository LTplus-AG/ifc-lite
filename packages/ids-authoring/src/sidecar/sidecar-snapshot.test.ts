/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { parseIDS } from '@ifc-lite/ids';
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { fromIdsDocument } from '../document/from-ids.js';
import { readIdsz, writeIdsz } from './idsz.js';
import {
  attachSidecar,
  createSidecar,
  fingerprintIds,
  parseSidecar,
  serializeSidecar,
  SIDECAR_SNAPSHOT_VERSION,
} from './sidecar.js';

// Several specifications, so re-identification has to tell them apart
// rather than match the only one there is (corpus files hold one each).
function spec(name: string, entity: string, pset: string, property: string): string {
  return `    <specification name="${name}" ifcVersion="IFC4">
      <applicability minOccurs="0" maxOccurs="unbounded">
        <entity><name><simpleValue>${entity}</simpleValue></name></entity>
      </applicability>
      <requirements>
        <property dataType="IFCLABEL">
          <propertySet><simpleValue>${pset}</simpleValue></propertySet>
          <baseName><simpleValue>${property}</simpleValue></baseName>
        </property>
      </requirements>
    </specification>`;
}
const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ids xmlns="http://standards.buildingsmart.org/IDS" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://standards.buildingsmart.org/IDS http://standards.buildingsmart.org/IDS/1.0/ids.xsd">
  <info><title>Snapshot fixture</title></info>
  <specifications>
${spec('Wall fire rating', 'IFCWALL', 'Pset_WallCommon', 'FireRating')}
${spec('Door fire rating', 'IFCDOOR', 'Pset_DoorCommon', 'FireRating')}
${spec('Slab acoustic rating', 'IFCSLAB', 'Pset_SlabCommon', 'AcousticRating')}
  </specifications>
</ids>
`;

/** Rename the first specification, as an external editor would. */
function editElsewhere(source: string): string {
  return source.replace(/(<(?:ids:)?specification\b[^>]*\bname=")([^"]*)"/, '$1$2 (rev B)"');
}

function annotated() {
  const doc = fromIdsDocument(parseIDS(xml));
  const target = doc.nodes.specs[1].id;
  doc.meta.comments[target] = [
    { id: doc.docId, resolved: false, comments: [{ author: 'a@example.com', at: '2026-10-11T00:00:00Z', text: 'check this' }] },
  ];
  return { doc, target };
}

describe('#7168 studio.json content snapshot', () => {
  it('embeds a versioned snapshot by default and round-trips it through JSON', () => {
    const { doc } = annotated();
    const sidecar = createSidecar(doc, xml);
    expect(sidecar.snapshot?.version).toBe(SIDECAR_SNAPSHOT_VERSION);
    const back = parseSidecar(serializeSidecar(sidecar));
    expect(back).toEqual(sidecar);
    expect(back.snapshot!.ids).toEqual(doc.ids);
    const { doc: attached, binding } = attachSidecar(parseIDS(xml), back);
    expect(binding).toBe('exact');
    expect(attached).toEqual(doc);
  });

  it('re-identifies a standalone .idsz edited elsewhere without the previous document', () => {
    const { doc, target } = annotated();
    const bundle = writeIdsz({ xml, sidecar: createSidecar(doc, xml) });

    // Someone edits ids.xml in another tool and re-zips the bundle.
    const read = readIdsz(bundle);
    const editedXml = editElsewhere(read.xml);
    expect(editedXml).not.toBe(read.xml);
    const reread = readIdsz(writeIdsz({ ...read, xml: editedXml }));
    const edited = parseIDS(reread.xml);
    expect(fingerprintIds(edited)).not.toBe(reread.sidecar!.idsFingerprint);

    const result = attachSidecar(edited, reread.sidecar!);
    expect(result.binding).toBe('reidentified');
    if (result.binding !== 'reidentified') return;
    expect(result.basis).toBe('snapshot');
    expect(result.report.specs.added).toEqual([]);
    expect(result.report.specs.removed).toEqual([]);
    // Every specification keeps its node id, including the renamed one.
    expect(result.doc.nodes.specs.map((s) => s.id)).toEqual(doc.nodes.specs.map((s) => s.id));
    expect(result.doc.ids.specifications[0].name).toMatch(/\(rev B\)$/);
    // Meta keyed by node id (the comment thread) still lands on its node.
    expect(result.doc.docId).toBe(doc.docId);
    expect(result.doc.meta.comments[target]).toEqual(doc.meta.comments[target]);
    expect(result.doc.nodes.specs.some((s) => s.id === target)).toBe(true);
  });

  it('prefers an explicit previous document over the snapshot', () => {
    const { doc } = annotated();
    const sidecar = createSidecar(doc, xml);
    const result = attachSidecar(parseIDS(editElsewhere(xml)), sidecar, { previous: doc });
    expect(result.binding).toBe('reidentified');
    expect(result.binding === 'reidentified' && result.basis).toBe('previous');
  });

  it('still loads an old bundle whose sidecar has no snapshot', () => {
    const { doc } = annotated();
    // Byte-for-byte what the pre-snapshot writer produced: no `snapshot` key.
    const old = { ...createSidecar(doc, xml) } as Record<string, unknown>;
    delete old.snapshot;
    const oldJson = `${JSON.stringify(old, null, 2)}\n`;
    expect(oldJson).not.toContain('"snapshot"');
    const bundle = zipSync({ 'ids.xml': strToU8(xml), 'studio.json': strToU8(oldJson) });

    const read = readIdsz(bundle);
    expect(read.sidecar).toBeDefined();
    expect(read.sidecar!.snapshot).toBeUndefined();
    const exact = attachSidecar(parseIDS(read.xml), read.sidecar!);
    expect(exact.binding).toBe('exact');
    expect(exact.doc).toEqual(doc);

    // Without a snapshot or previous document an external edit falls back to fresh ids.
    const edited = attachSidecar(parseIDS(editElsewhere(read.xml)), read.sidecar!);
    expect(edited.binding).toBe('fresh');
    expect(edited.doc.docId).toBe(doc.docId);
  });

  it('can be left out on request', () => {
    const { doc } = annotated();
    expect(createSidecar(doc, xml, { snapshot: false }).snapshot).toBeUndefined();
    expect(serializeSidecar(createSidecar(doc, xml, { snapshot: false }))).not.toContain('"snapshot"');
  });

  it('ignores a snapshot of a later version and refuses a malformed version-1 snapshot', () => {
    const { doc } = annotated();
    const sidecar = createSidecar(doc, xml);
    const later = parseSidecar(JSON.stringify({ ...sidecar, snapshot: { version: 2, somethingNew: true } }));
    expect(later.snapshot).toEqual({ version: 2, somethingNew: true });
    expect(attachSidecar(parseIDS(editElsewhere(xml)), later).binding).toBe('fresh');

    for (const bad of [
      { version: 1 },
      { version: 1, ids: { info: {}, specifications: {} } },
      { version: 1, ids: { info: {}, specifications: [{ requirements: [] }] } },
      { version: 0, ids: sidecar.snapshot!.ids },
      { version: '1', ids: sidecar.snapshot!.ids },
    ]) {
      expect(() => parseSidecar(JSON.stringify({ ...sidecar, snapshot: bad })), JSON.stringify(bad).slice(0, 80))
        .toThrow(/IDS Studio sidecar.*snapshot/);
    }
  });

  it('falls back to fresh ids when the snapshot does not fit the node index', () => {
    const { doc } = annotated();
    const sidecar = createSidecar(doc, xml);
    const mismatched = { ...sidecar, snapshot: { version: 1, ids: { ...doc.ids, specifications: doc.ids.specifications.slice(1) } } };
    expect(attachSidecar(parseIDS(editElsewhere(xml)), parseSidecar(JSON.stringify(mismatched))).binding).toBe('fresh');
  });
});
