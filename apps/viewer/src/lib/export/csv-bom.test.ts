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
import type { CompareResult } from '@/store/slices/compareSlice';
import { downloadCompareReport } from '../compare/exportReport';
import { buildExportModel, createListArtifact, exportList } from '../lists/export';
import { downloadFile } from './download';

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

describe('CSV downloads carry a UTF-8 BOM (#11452)', () => {
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

  it('downloadFile with a CSV ArrayBuffer', async () => {
    stubBrowser();
    downloadFile(new TextEncoder().encode('Sală\n').buffer, 'a.csv', 'text/csv');
    const bytes = await bytesOf(captured!);
    assert.deepStrictEqual(bytes.slice(0, 3), BOM);
    assert.strictEqual(new TextDecoder().decode(new Uint8Array(bytes.slice(3))), 'Sală\n');
  });

  it('adds the BOM to the list download and keeps generated artifacts BOM-free', async () => {
    stubBrowser();
    const model = buildExportModel({
      title: 'Rooms', columns: [{ id: 'name', source: 'attribute', propertyName: 'Name' }],
      rows: [{ entityId: 1, modelId: 'model', values: ['Sală'] }],
      numericCols: [false], columnWidths: [120], generatedAt: 'now',
    });
    const artifact = await createListArtifact('csv', model);
    const raw = await bytesOf(artifact.blob);
    assert.notDeepStrictEqual(raw.slice(0, 3), BOM);
    await exportList('csv', model);
    const bytes = await bytesOf(captured!);
    assert.deepStrictEqual(bytes.slice(0, 3), BOM);
    assert.deepStrictEqual(bytes.slice(3), raw);
  });

  it('adds the BOM to comparison CSV downloads and keeps JSON unchanged', async () => {
    stubBrowser();
    const result = {
      baseModelId: 'a', headModelId: 'b', baseName: 'Sală', headName: 'Nou',
      scope: 'both', geometryUnavailable: false,
      diff: { entries: [], excludedTypes: [], byKey: new Map(), counts: { added: 0, modified: 0, deleted: 0, unchanged: 0 } },
    } as unknown as CompareResult;
    downloadCompareReport('csv', result, new Map());
    assert.deepStrictEqual((await bytesOf(captured!)).slice(0, 3), BOM);
    downloadCompareReport('json', result, new Map());
    assert.strictEqual((await bytesOf(captured!))[0], 0x7b);
  });
});
