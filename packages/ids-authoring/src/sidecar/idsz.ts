/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `.idsz` bundle: a plain zip anyone can inspect (01-overview.md §7).
 *
 *   ids.xml          the IDS, byte-for-byte as given
 *   studio.json      the sidecar (optional)
 *   fixtures/<name>  test models (optional)
 *   appendix.pdf     readable appendix (optional, produced elsewhere)
 *
 * The XML is stored verbatim, so a bundle with and without sidecar carries
 * byte-identical XML. Entries use a fixed timestamp, so writing the same
 * content twice yields the same bytes.
 */

import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import { parseSidecar, serializeSidecar, SIDECAR_FILENAME, type StudioSidecar } from './sidecar.js';

export const IDSZ_XML = 'ids.xml';
export const IDSZ_APPENDIX = 'appendix.pdf';
const FIXTURE_DIR = 'fixtures/';

export interface IdszContent {
  xml: string;
  sidecar?: StudioSidecar;
  /** File name → bytes. Names must not contain path separators. */
  fixtures?: Record<string, Uint8Array>;
  appendix?: Uint8Array;
}

const FIXED_MTIME = new Date(Date.UTC(1980, 0, 1, 0, 0, 0));

export function writeIdsz(content: IdszContent): Uint8Array {
  const files: Zippable = { [IDSZ_XML]: [strToU8(content.xml), { mtime: FIXED_MTIME }] };
  if (content.sidecar) files[SIDECAR_FILENAME] = [strToU8(serializeSidecar(content.sidecar)), { mtime: FIXED_MTIME }];
  for (const [name, bytes] of Object.entries(content.fixtures ?? {})) {
    if (!name || name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
      throw new Error(`invalid fixture name "${name}"`);
    }
    files[`${FIXTURE_DIR}${name}`] = [bytes, { mtime: FIXED_MTIME }];
  }
  if (content.appendix) files[IDSZ_APPENDIX] = [content.appendix, { mtime: FIXED_MTIME }];
  return zipSync(files, { level: 6 });
}

/** Read a bundle. Unknown entries are ignored; a missing `ids.xml` throws. */
export function readIdsz(bytes: Uint8Array): IdszContent {
  const entries = unzipSync(bytes);
  const xml = entries[IDSZ_XML];
  if (!xml) throw new Error(`not an .idsz bundle: ${IDSZ_XML} is missing`);
  const out: IdszContent = { xml: strFromU8(xml) };
  const sidecar = entries[SIDECAR_FILENAME];
  if (sidecar) out.sidecar = parseSidecar(strFromU8(sidecar));
  const fixtures: Record<string, Uint8Array> = {};
  for (const [path, data] of Object.entries(entries)) {
    if (path.startsWith(FIXTURE_DIR) && path.length > FIXTURE_DIR.length && !path.endsWith('/')) {
      fixtures[path.slice(FIXTURE_DIR.length)] = data;
    }
  }
  if (Object.keys(fixtures).length) out.fixtures = fixtures;
  if (entries[IDSZ_APPENDIX]) out.appendix = entries[IDSZ_APPENDIX];
  return out;
}
