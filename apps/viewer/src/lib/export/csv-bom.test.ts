/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Excel on Windows opens a double-clicked `.csv` in the ANSI code page unless
 * the file starts with a UTF-8 byte-order mark, so `Sală` shows as `SalÄƒ`.
 * Every user-facing CSV download must therefore start with EF BB BF, exactly
 * once, whichever surface produced it.
 */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert';
import { csvBlob, downloadFile } from './download';

const BOM = [0xef, 0xbb, 0xbf];

async function bytesOf(blob: Blob): Promise<number[]> {
  return [...new Uint8Array(await blob.arrayBuffer())];
}

const g = globalThis as Record<string, unknown>;
const saved = { document: g.document, URL: g.URL };
let captured: Blob | null = null;

function stubBrowser(): void {
  captured = null;
  g.document = {
    createElement: () => ({ click() {}, remove() {} }),
    body: { appendChild() {} },
  };
  g.URL = Object.assign(Object.create(saved.URL as object), {
    createObjectURL: (b: Blob) => { captured = b; return 'blob:x'; },
    revokeObjectURL: () => {},
  });
}
afterEach(() => { g.document = saved.document; g.URL = saved.URL; });

describe('CSV downloads carry a UTF-8 BOM', () => {
  it('downloadFile with a text/csv string', async () => {
    stubBrowser();
    downloadFile('Name\nSală\n', 'a.csv', 'text/csv;charset=utf-8');
    const bytes = await bytesOf(captured!);
    assert.deepStrictEqual(bytes.slice(0, 3), BOM);
    assert.strictEqual(new TextDecoder().decode(new Uint8Array(bytes.slice(3))), 'Name\nSală\n');
  });

  it('downloadFile with text/csv bytes', async () => {
    stubBrowser();
    downloadFile(new TextEncoder().encode('Größe\n'), 'a.csv', 'text/csv');
    assert.deepStrictEqual((await bytesOf(captured!)).slice(0, 3), BOM);
  });

  it('does not double an existing BOM', async () => {
    stubBrowser();
    downloadFile('﻿x\n', 'a.csv', 'text/csv');
    const bytes = await bytesOf(captured!);
    assert.deepStrictEqual(bytes.slice(0, 3), BOM);
    assert.notDeepStrictEqual(bytes.slice(3, 6), BOM);
  });

  it('leaves non-CSV downloads untouched', async () => {
    stubBrowser();
    downloadFile('{"a":1}', 'a.json', 'application/json');
    assert.strictEqual((await bytesOf(captured!))[0], 0x7b);
  });

  it('csvBlob (list export, playground artifacts)', async () => {
    const blob = csvBlob('Sală\n');
    assert.match(blob.type, /^text\/csv/);
    const bytes = await bytesOf(blob);
    assert.deepStrictEqual(bytes.slice(0, 3), BOM);
    assert.strictEqual(new TextDecoder().decode(new Uint8Array(bytes.slice(3))), 'Sală\n');
  });
});
