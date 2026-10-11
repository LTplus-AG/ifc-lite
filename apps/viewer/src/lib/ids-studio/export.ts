/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Saving from IDS Studio (IDS-040): the IDS XML on its own (`.ids`), or a
 * Studio bundle (`.idsz`: the XML plus the `studio.json` sidecar that keeps
 * node ids, comments and custom sets). Both are written by the same shared
 * writer the XML preview shows (`./xml.ts`), so what is saved is what is seen.
 */

import { createSidecar, writeIdsz, type StudioDocument } from '@ifc-lite/ids-authoring';
import { studioXml } from './xml';

export type StudioExport<T> = { ok: true; content: T; fileName: string } | { ok: false; error: string };

/** A file name from the document title: letters, digits, `-` and `_`; never empty. */
export function studioFileName(doc: StudioDocument, extension: 'ids' | 'idsz'): string {
  const stem = doc.ids.info.title.normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  return `${stem || 'ids'}.${extension}`;
}

export function exportIds(doc: StudioDocument): StudioExport<string> {
  const written = studioXml(doc);
  return written.ok ? { ok: true, content: written.xml, fileName: studioFileName(doc, 'ids') } : written;
}

export function exportIdsz(doc: StudioDocument): StudioExport<Uint8Array> {
  const written = studioXml(doc);
  if (!written.ok) return written;
  try {
    const sidecar = createSidecar(doc, written.xml);
    return { ok: true, content: writeIdsz({ xml: written.xml, sidecar }), fileName: studioFileName(doc, 'idsz') };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
