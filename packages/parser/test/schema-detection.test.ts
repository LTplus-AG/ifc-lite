/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Schema detection must come from the header's `FILE_SCHEMA` declaration, not
 * from a substring scan of the raw header bytes (issue #3278).
 *
 * The header carries free text — author, organisation, preprocessor version,
 * originating system — and exporter product names routinely contain a schema
 * token ("SomeApp IFC4 Exporter"). A raw `includes('IFC4')` cannot tell that
 * apart from `FILE_SCHEMA(('IFC4'))`, and because `IFC4` was tested before
 * `IFC2X3` the free text won.
 *
 * Everything here goes through the real `ColumnarParser.parseLite` path on real
 * bytes, and the last case asserts an OUTPUT (schedule extraction), because the
 * schema version selects the IfcTask attribute layout in `schedule-extractor`.
 */

import { describe, it, expect } from 'vitest';
import { StepTokenizer } from '../src/tokenizer.js';
import { ColumnarParser } from '../src/columnar-parser.js';
import { extractScheduleOnDemand } from '../src/index.js';

/** Run the real worker-free parser on a STEP buffer. */
async function parseStep(stepText: string) {
  const buffer = new TextEncoder().encode(stepText).buffer.slice(0) as ArrayBuffer;
  const source = new Uint8Array(buffer);
  const tokenizer = new StepTokenizer(source);
  const entityRefs: Array<{
    expressId: number;
    type: string;
    byteOffset: number;
    byteLength: number;
    lineNumber: number;
  }> = [];
  for (const ref of tokenizer.scanEntitiesFast()) {
    entityRefs.push({
      expressId: ref.expressId,
      type: ref.type,
      byteOffset: ref.offset,
      byteLength: ref.length,
      lineNumber: ref.line,
    });
  }
  return new ColumnarParser().parseLite(buffer, entityRefs, {});
}

interface StepOptions {
  /** Spliced verbatim, so a case can omit `FILE_SCHEMA` entirely. */
  schemaLine?: string;
  /** Lands in the two free-text `FILE_NAME` slots exporters stamp. */
  originatingSystem?: string;
  /**
   * The single `FILE_DESCRIPTION` item, spliced verbatim BETWEEN the quotes.
   * A `'` inside it must be written `''`, as STEP requires.
   */
  descriptionItem?: string;
  /** Inflates the author list, pushing the later `FILE_SCHEMA` further in. */
  authorPad?: string;
  dataLines?: string[];
}

/** A minimal but structurally real IFC file. */
function buildStep(opts: StepOptions): string {
  const {
    schemaLine = "FILE_SCHEMA(('IFC2X3'));",
    originatingSystem = 'SomeApp Exporter',
    descriptionItem = 'ViewDefinition [CoordinationView_V2.0]',
    authorPad = '',
    dataLines = [],
  } = opts;
  return [
    'ISO-10303-21;',
    'HEADER;',
    `FILE_DESCRIPTION(('${descriptionItem}'),'2;1');`,
    `FILE_NAME('model.ifc','2026-01-01T00:00:00',('${authorPad}Jane Doe'),('Acme'),` +
      `'${originatingSystem}','${originatingSystem}','');`,
    schemaLine,
    'ENDSEC;',
    'DATA;',
    "#1=IFCPROJECT('proj',#10,'P',$,$,$,$,$,$);",
    '#10=IFCOWNERHISTORY($,$,$,.NOCHANGE.,$,$,$,0);',
    ...dataLines,
    'ENDSEC;',
    'END-ISO-10303-21;',
    '',
  ].join('\n');
}

/** Build and parse in one step. */
async function parse(opts: StepOptions) {
  return parseStep(buildStep(opts));
}

describe('schema detection reads FILE_SCHEMA, not free header text', () => {
  // Every FILE_SCHEMA spelling that appears in this repo's fixtures and
  // exporters. Anti-vacuity guard: if the detector regressed to always
  // answering one value, these rows catch it.
  it.each([
    ['IFC2X3', 'IFC2X3'],
    ['IFC4', 'IFC4'],
    ['IFC4X1', 'IFC4'],
    ['IFC4X2', 'IFC4'],
    ['IFC4X3', 'IFC4X3'],
    ['IFC4X3_ADD2', 'IFC4X3'],
    ['IFC5', 'IFC5'],
  ])('declares %s -> %s', async (token, expected) => {
    const store = await parse({ schemaLine: `FILE_SCHEMA(('${token}'));` });
    expect(store.schemaVersion).toBe(expected);
  });

  it('an IFC2X3 file whose header names an IFC4 exporter stays IFC2X3', async () => {
    const store = await parse({ originatingSystem: 'SomeApp IFC4 Exporter' });
    expect(store.schemaVersion).toBe('IFC2X3');
  });

  it('an IFC2X3 file whose header names an IFC4X3 exporter stays IFC2X3', async () => {
    const store = await parse({ originatingSystem: 'SomeApp IFC4X3 Exporter' });
    expect(store.schemaVersion).toBe('IFC2X3');
  });

  // The other direction of the same rule: free text must not drag a newer
  // file backwards either.
  it('an IFC4 file whose header names an IFC2X3 converter stays IFC4', async () => {
    const store = await parse({
      schemaLine: "FILE_SCHEMA(('IFC4'));",
      originatingSystem: 'Legacy IFC2X3 Migrator',
    });
    expect(store.schemaVersion).toBe('IFC4');
  });

  it('finds FILE_SCHEMA past the first 2000 bytes of a long header', async () => {
    const text = buildStep({ authorPad: 'X'.repeat(2100) });
    // Guard the fixture itself: if the record moved back inside the old
    // window this case would pass for the wrong reason.
    expect(text.indexOf('FILE_SCHEMA')).toBeGreaterThan(2000);
    const store = await parseStep(text);
    expect(store.schemaVersion).toBe('IFC2X3');
  });

  /**
   * The same rule as every case above -- free text is not a declaration -- but
   * one level down, where the free text is a verbatim copy of the RECORD
   * rather than a loose token. A file that has been round-tripped through a
   * tool which quotes the header it read carries `FILE_SCHEMA(('IFC2X3'))`
   * inside a `FILE_DESCRIPTION` string, ahead of the real declaration. A
   * keyword search that does not track quotes takes the copy.
   */
  it('a FILE_DESCRIPTION containing a quoted FILE_SCHEMA record does not win', async () => {
    const store = await parse({
      descriptionItem: "round-tripped from FILE_SCHEMA((''IFC2X3''))",
      schemaLine: "FILE_SCHEMA(('IFC4X3_ADD2'));",
    });
    expect(store.schemaVersion).toBe('IFC4X3');
  });

  /**
   * The other half of the same defect. The header is truncated at `ENDSEC` so
   * the DATA section is never scanned; a quoted `ENDSEC` in free text would cut
   * the header BEFORE the real `FILE_SCHEMA` record, losing the declaration and
   * dropping detection back to the raw-byte fallback.
   */
  it('a FILE_DESCRIPTION containing a quoted ENDSEC does not truncate the header', async () => {
    const store = await parse({
      descriptionItem: 'exported up to ENDSEC; and beyond',
      schemaLine: "FILE_SCHEMA(('IFC4X3_ADD2'));",
    });
    expect(store.schemaVersion).toBe('IFC4X3');
  });

  /**
   * Control for the two cases above: the SAME hostile description with a
   * DIFFERENT real declaration. Without this, a detector that had regressed to
   * answering IFC4X3 unconditionally would satisfy both of them.
   */
  it('the hostile description does not decide the answer either way', async () => {
    const store = await parse({
      descriptionItem: "round-tripped from FILE_SCHEMA((''IFC4X3_ADD2'')) up to ENDSEC;",
      schemaLine: "FILE_SCHEMA(('IFC2X3'));",
    });
    expect(store.schemaVersion).toBe('IFC2X3');
  });

  it('ignores schema-like text stored in the DATA section', async () => {
    const store = await parse({
      dataLines: ["#20=IFCPROPERTYSINGLEVALUE('Note',$,IFCTEXT('exported via IFC4'),$);"],
    });
    expect(store.schemaVersion).toBe('IFC2X3');
  });

  // Negative control: with no declaration to read, behaviour is unchanged —
  // still the historical IFC4 default, not a new refusal.
  it('falls back to IFC4 when the header declares no FILE_SCHEMA', async () => {
    const store = await parse({ schemaLine: "FILE_DESCRIPTION((''),'2;1');" });
    expect(store.schemaVersion).toBe('IFC4');
  });

  // ...and the raw scan is still the fallback, so an undeclared file whose
  // header says IFC2X3 in free text keeps resolving the way it does today.
  it('falls back to the raw scan when no FILE_SCHEMA is declared', async () => {
    const store = await parse({
      schemaLine: "FILE_DESCRIPTION((''),'2;1');",
      originatingSystem: 'SomeApp IFC2X3 Exporter',
    });
    expect(store.schemaVersion).toBe('IFC2X3');
  });

  it('reads IFC2X3 IfcTask attributes when the header names an IFC4 exporter', async () => {
    // IFC2X3 IfcTask: GlobalId, OwnerHistory, Name, Description, ObjectType,
    // TaskId, Status, WorkMethod, IsMilestone, Priority. The IFC4 layout
    // diverges from index 5 on, so a misdetected schema shifts every field
    // from Status rightwards.
    const store = await parse({
      originatingSystem: 'SomeApp IFC4 Exporter',
      dataLines: [
        "#20=IFCTASK('task-gid',#10,'Excavate','desc','otype','T-001','STARTED','Manual',.F.,3);",
      ],
    });
    const task = extractScheduleOnDemand(store).tasks[0];
    expect(task).toBeDefined();
    expect(task.identification).toBe('T-001');
    expect(task.status).toBe('STARTED');
    expect(task.workMethod).toBe('Manual');
    expect(task.priority).toBe(3);
    expect(task.longDescription).toBeUndefined();
  });
});
