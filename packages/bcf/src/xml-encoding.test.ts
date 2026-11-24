/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Interop: the reader decoded every XML entry as UTF-8. A UTF-16 markup.bcf
 * (valid XML, written by .NET `Encoding.Unicode` writers) decoded to NUL
 * interleaved text, so the topic was dropped; a UTF-16 bcf.version rejected
 * the whole archive; an ISO-8859-1 file turned accented characters into U+FFFD.
 */
import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { readBCF } from './reader.js';

const GUID = '8ac9822a-761a-4deb-9f39-f61286acbf6a';
const version = (enc: string) => `<?xml version="1.0" encoding="${enc}"?>\n<Version VersionId="2.1"><DetailedVersion>2.1</DetailedVersion></Version>`;
const markup = (enc: string, title: string) => `<?xml version="1.0" encoding="${enc}"?>
<Markup><Topic Guid="${GUID}" TopicType="Issue" TopicStatus="Open"><Title>${title}</Title>
<CreationDate>2026-01-01T00:00:00Z</CreationDate><CreationAuthor>a@example.com</CreationAuthor></Topic></Markup>`;

const utf16le = (s: string, bom: boolean) => {
  const b = Buffer.from(s, 'utf16le');
  return bom ? Buffer.concat([Buffer.from([0xff, 0xfe]), b]) : b;
};
const utf16be = (s: string, bom: boolean) => {
  const b = Buffer.from(s, 'utf16le').swap16();
  return bom ? Buffer.concat([Buffer.from([0xfe, 0xff]), b]) : b;
};

async function read(versionBytes: Uint8Array | string, markupBytes: Uint8Array | string) {
  const zip = new JSZip();
  zip.file('bcf.version', versionBytes);
  zip.file(`${GUID}/markup.bcf`, markupBytes);
  return readBCF(await zip.generateAsync({ type: 'uint8array' }));
}

describe('XML entry encodings', () => {
  const title = 'Brandschutz Stütze – 墙';
  it.each([
    ['UTF-16LE with BOM', (s: string) => utf16le(s, true)],
    ['UTF-16LE without BOM', (s: string) => utf16le(s, false)],
    ['UTF-16BE with BOM', (s: string) => utf16be(s, true)],
    ['UTF-16BE without BOM', (s: string) => utf16be(s, false)],
  ])('reads a %s archive', async (_n, enc) => {
    const p = await read(enc(version('utf-16')), enc(markup('utf-16', title)));
    expect(p.topics.get(GUID)?.title).toBe(title);
  });

  it('ignores a utf-16 declaration over UTF-8 bytes (the byte shape wins)', async () => {
    const p = await read(version('utf-16'), markup('utf-16', title));
    expect(p.topics.get(GUID)?.title).toBe(title);
  });

  it('reads an ISO-8859-1 file with accented characters', async () => {
    const bytes = Buffer.from(markup('ISO-8859-1', 'Stütze'), 'latin1');
    const p = await read(version('UTF-8'), bytes);
    expect(p.topics.get(GUID)?.title).toBe('Stütze');
  });

  it('keeps the lenient UTF-8 decode for invalid bytes with no Latin declaration', async () => {
    const bytes = Buffer.from(markup('UTF-8', 'Stütze'), 'latin1');
    const p = await read(version('UTF-8'), bytes);
    expect(p.topics.get(GUID)?.title).toBe('St�tze');
  });
});
