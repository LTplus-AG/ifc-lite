/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Opening files in IDS Studio (IDS-040): an IDS (`.ids` / `.xml`) or a Studio
 * bundle (`.idsz`: the XML plus its `studio.json` sidecar). Opening creates a
 * new Studio document; it is not an edit of the open one.
 */

import { parseIDS } from '@ifc-lite/ids';
import { attachSidecar, fromIdsDocument, readIdsz, type StudioDocument } from '@ifc-lite/ids-authoring';

export type ImportResult =
  | { ok: true; doc: StudioDocument; format: 'ids' | 'idsz'; binding?: 'exact' | 'reidentified' | 'fresh' }
  | { ok: false; error: string };

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function importIdsXml(xml: string): ImportResult {
  try {
    return { ok: true, doc: fromIdsDocument(parseIDS(xml)), format: 'ids' };
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}

/** A bundle keeps its node ids and sidecar (comments, suppressions, custom sets) when the XML still matches it. */
export function importIdsz(bytes: Uint8Array, previous?: StudioDocument): ImportResult {
  try {
    const bundle = readIdsz(bytes);
    const ids = parseIDS(bundle.xml);
    if (!bundle.sidecar) return { ok: true, doc: fromIdsDocument(ids), format: 'idsz' };
    const attached = attachSidecar(ids, bundle.sidecar, previous ? { previous } : {});
    return { ok: true, doc: attached.doc, format: 'idsz', binding: attached.binding };
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}

/** Read a picked or dropped file by its extension. */
export async function importStudioFile(file: File, previous?: StudioDocument): Promise<ImportResult> {
  if (/\.idsz$/i.test(file.name)) return importIdsz(new Uint8Array(await file.arrayBuffer()), previous);
  return importIdsXml(await file.text());
}
