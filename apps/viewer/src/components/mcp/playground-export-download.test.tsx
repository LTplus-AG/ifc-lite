/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { cleanup, click, render } from '@/test/render.js';
import { dispatch, parsePlaygroundModel } from './playground-dispatcher.js';
import { playgroundFiles } from './playground-files.js';
import { InlineDownload } from './playground-inline-download.js';

const encoder = new TextEncoder();
const modelBytes = encoder.encode([
  'ISO-10303-21;', 'HEADER;', "FILE_DESCRIPTION((''),'2;1');",
  "FILE_NAME('','',(''),(''),'','','');", "FILE_SCHEMA(('IFC4'));", 'ENDSEC;',
  'DATA;', "#1=IFCWALL('0aBcDeFgHiJkLmNoPqRsT1',$,'Sal\\X2\\0103\\X0\\',$,$,$,$,$,.STANDARD.);",
  'ENDSEC;', 'END-ISO-10303-21;',
].join('\n'));

afterEach(() => {
  cleanup();
  playgroundFiles.clear();
});

describe('Playground staged exports (#11452)', () => {
  const cases = [
    {
      title: 'CSV adds one BOM on download', format: 'csv', columns: ['Name'],
      stored: 'Name\nSală', saved: '\uFEFFName\nSală', mime: 'text/csv',
    },
    // The exporter writes column labels verbatim, so this header begins with a BOM.
    {
      title: 'CSV with an existing BOM downloads byte for byte', format: 'csv',
      columns: ['\uFEFFName', 'Name'], stored: '\uFEFFName,Name\n,Sală', mime: 'text/csv',
    },
    {
      title: 'JSON downloads byte for byte', format: 'json', columns: ['Name'],
      stored: '[\n  {\n    "Name": "Sală"\n  }\n]', mime: 'application/json',
    },
  ];

  for (const { title, format, columns, stored, saved, mime } of cases) {
    it(title, async (t) => {
      const downloads: Blob[] = [];
      const createObjectURL = URL.createObjectURL.bind(URL);
      t.mock.method(URL, 'createObjectURL', (blob: Blob) => {
        downloads.push(blob);
        return createObjectURL(blob);
      });
      const model = await parsePlaygroundModel(modelBytes.buffer, 'walls.ifc');
      const result = await dispatch(model, `export_${format}`, { type: 'IfcWall', columns });
      assert.equal(result.isError, false, result.text);
      const { download } = result;
      assert.ok(download);
      const file = playgroundFiles.list().find(({ id }) => id === download.fileId);
      assert.ok(file);

      const original = encoder.encode(stored);
      assert.deepEqual(new Uint8Array(await file.blob.arrayBuffer()), original);
      assert.equal(file.size, original.length);
      assert.equal(download.size, original.length);
      assert.deepEqual(result.structured, {
        fileId: file.id, filename: `IfcWall.${format}`, rows: 1, bytes: original.length,
      });
      assert.match(result.text, new RegExp(`${original.length} B`));
      const ui = render(<InlineDownload download={download} />);
      const button = ui.querySelector('button');
      assert.ok(button);
      assert.equal(downloads.length, 0, 'staging does not start a download');

      click(button);
      assert.equal(downloads.length, 1);
      assert.equal(downloads[0].type, mime);
      assert.deepEqual(new Uint8Array(await downloads[0].arrayBuffer()), encoder.encode(saved ?? stored));
      assert.deepEqual(new Uint8Array(await file.blob.arrayBuffer()), original, 'downloading preserves the staged bytes');
    });
  }
});
