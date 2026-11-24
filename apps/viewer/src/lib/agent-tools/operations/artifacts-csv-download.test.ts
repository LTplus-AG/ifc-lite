/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import type { ToolHost } from '../types';
import { downloadArtifact, operationArtifacts, readArtifact } from './artifacts';

const host = {} as ToolHost;
const original = URL.createObjectURL;
afterEach(() => { URL.createObjectURL = original; });

function captureDownload(id: string): Blob {
  let saved: Blob | undefined;
  URL.createObjectURL = (b: Blob | MediaSource) => { saved = b as Blob; return 'blob:test'; };
  downloadArtifact(host, id);
  assert.ok(saved);
  return saved;
}
const head = async (b: Blob) => [...new Uint8Array(await b.slice(0, 3).arrayBuffer())];

describe('agent CSV artifacts (#11452)', () => {
  it('downloads with a UTF-8 BOM while the agent-read bytes stay verbatim', async () => {
    const m = await operationArtifacts(host, w => w()).create({ filename: 'a.csv', mimeType: 'text/csv', data: 'Sală,1\n' });
    assert.deepStrictEqual(await head(captureDownload(m.artifact_id)), [0xef, 0xbb, 0xbf]);
    const read = await readArtifact(host, m.artifact_id, 0, 3);
    assert.strictEqual(Buffer.from(read.data, 'base64').toString('utf8'), 'Sal');
  });

  it('does not double an existing BOM and leaves non-CSV artifacts alone', async () => {
    const arts = operationArtifacts(host, w => w());
    const csv = await arts.create({ filename: 'b.csv', mimeType: 'text/csv', data: '﻿x,1\n' });
    const dl = captureDownload(csv.artifact_id);
    assert.strictEqual(dl.size, new TextEncoder().encode('﻿x,1\n').length);
    const json = await arts.create({ filename: 'c.json', mimeType: 'application/json', data: '{}' });
    assert.strictEqual(captureDownload(json.artifact_id).size, 2);
  });
});
