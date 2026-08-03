/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '../../../../test/setup-dom.js';
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { importScheduleFromText } from './index.js';

const MSPDI_XML = `<?xml version="1.0"?>
<Project>
  <Name>Sniffed Project</Name>
  <Tasks>
    <Task><UID>1</UID><Name>Task A</Name><OutlineLevel>1</OutlineLevel>
      <Start>2026-01-05T08:00:00</Start><Finish>2026-01-06T17:00:00</Finish></Task>
    <Task><UID>2</UID><Name>Task B</Name><OutlineLevel>1</OutlineLevel>
      <PredecessorLink><PredecessorUID>1</PredecessorUID><Type>1</Type></PredecessorLink></Task>
  </Tasks>
</Project>`;

const CSV_TEXT = 'Name,Start,Finish\nTask 1,2026-01-05,2026-01-06\nTask 2,2026-01-07,2026-01-08\n';

describe('importScheduleFromText — format detection', () => {
  it('routes XML content to mspdi even when the file is named .txt', () => {
    const result = importScheduleFromText('export.txt', MSPDI_XML);
    assert.strictEqual(result.format, 'mspdi');
  });

  it('routes CSV content to csv', () => {
    const result = importScheduleFromText('export.csv', CSV_TEXT);
    assert.strictEqual(result.format, 'csv');
  });

  it('does not misroute a CSV whose text merely mentions "<Project>" (regression)', () => {
    const csv = 'Name,Duration,Notes\nFoundations,5 days,"see <Project> plan"\n';
    const result = importScheduleFromText('plan.csv', csv);
    assert.strictEqual(result.format, 'csv');
    assert.strictEqual(result.taskCount, 1);
  });

  it('routes an XML file with leading whitespace to mspdi', () => {
    const xml = `\n  \t${MSPDI_XML}`;
    const result = importScheduleFromText('export.txt', xml);
    assert.strictEqual(result.format, 'mspdi');
  });

  it('routes an XML file with a leading comment to mspdi', () => {
    const xml = `<!-- exported by MS Project -->\n${MSPDI_XML}`;
    const result = importScheduleFromText('export.txt', xml);
    assert.strictEqual(result.format, 'mspdi');
  });
});

describe('importScheduleFromText — result shape', () => {
  it('reports task/sequence counts matching the extraction', () => {
    const result = importScheduleFromText('export.txt', MSPDI_XML);
    assert.strictEqual(result.taskCount, result.extraction.tasks.length);
    assert.strictEqual(result.sequenceCount, result.extraction.sequences.length);
    assert.strictEqual(result.taskCount, 2);
    assert.strictEqual(result.sequenceCount, 1);
  });

  it('propagates parser errors unchanged', () => {
    assert.throws(() => importScheduleFromText('bad.csv', 'Foo,Bar\n1,2\n'), /task-name column/);
  });

  it('rejects a .mpp file with a clear message instead of a confusing CSV parse error', () => {
    // Binary content — doesn't start with '<' and has no recognised
    // extension, so without the explicit .mpp check this would silently
    // fall through to the CSV parser and fail with an unrelated
    // "no data rows" error.
    assert.throws(
      () => importScheduleFromText('Project1.mpp', '\x00\x00OLE binary garbage\x00'),
      /\.mpp.*Save As.*XML/s,
    );
  });

  it('produces identical GlobalIds when the same file is imported twice', () => {
    const first = importScheduleFromText('export.csv', CSV_TEXT);
    const second = importScheduleFromText('export.csv', CSV_TEXT);
    assert.deepStrictEqual(
      first.extraction.tasks.map(t => t.globalId),
      second.extraction.tasks.map(t => t.globalId),
    );
  });

  it('propagates the CSV front end\'s detected date order (#1963: was dropped between ParsedScheduleSource and ScheduleImportResult)', () => {
    const result = importScheduleFromText('export.csv', CSV_TEXT);
    assert.strictEqual(result.dateOrder, 'iso');
  });

  it('leaves dateOrder undefined for an MSPDI import (no day/month guess to report)', () => {
    const result = importScheduleFromText('export.txt', MSPDI_XML);
    assert.strictEqual(result.dateOrder, undefined);
  });
});
