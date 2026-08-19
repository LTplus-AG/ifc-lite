/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Coverage gap (issue #2475): a mutation sweep of `buildHeader` /
 * `generateHeader` wiring in step-exporter.ts (~:331-357) found that every
 * caller-supplied `StepExportOptions` header override, plus two
 * sourceHeader-fallback fields nobody exercised with a non-default value,
 * were dead code as far as the test suite could tell — mutating each site
 * alone killed nothing:
 *
 *  - `options.description !== undefined` branch (~:332-333)
 *  - `implementationLevel: sourceHeader?.implementationLevel` (~:347)
 *  - `options.author ?? sourceHeader?.author` — the `options.author` half (~:348)
 *  - `options.organization ?? sourceHeader?.organization` — the `options.organization` half (~:349)
 *  - `options.application` override of `preprocessorVersion` (~:352)
 *  - `authorization: sourceHeader?.authorization` (~:354)
 *  - `options.filename ?? 'export.ifc'` — the `options.filename` half (~:355-356)
 *  - `timeStamp: options.timeStamp` (~:454): the eighth override, added
 *    after the original sweep: mutating it to `undefined` still killed
 *    nothing once the seven above were covered.
 *
 * Every fixture below gives the source header a value DIFFERENT from both
 * the caller override (where one applies) and the hardcoded default, so a
 * passing assertion proves the specific wiring under test, not a
 * coincidence with a fallback or default that happens to share a string.
 * FILE_NAME / FILE_DESCRIPTION arguments are positional, so values are
 * asserted against their exact parsed field, never "appears in the line".
 *
 * All fixtures are synthetic and carry no real-world identifiers.
 */

import { describe, expect, it } from 'vitest';
import { IfcParser, parseSourceHeader, type IfcDataStore } from '@ifc-lite/parser';
import { StepExporter } from './step-exporter.js';

const enc = (s: string): ArrayBuffer => new TextEncoder().encode(s).buffer as ArrayBuffer;

/** Source header with distinctive, non-default values in every field this
 *  suite exercises, so an override or fallback landing in the wrong slot
 *  (or not landing at all) is unambiguous. */
const SOURCE_MODEL = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('Source Description Item'),'3;7');
FILE_NAME('source-file.ifc','2026-01-01T00:00:00',('Source Author'),('Source Organization'),'Source Preprocessor','Source Originating System','source-authorization-token');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCWALL('3wkd_mjInDCfOthy7w_A6V',$,'Sample Wall',$,$,$,$,$,$);
ENDSEC;
END-ISO-10303-21;`;

async function parse(model: string): Promise<IfcDataStore> {
  return new IfcParser().parseColumnar(enc(model));
}

function exportedHeader(content: Uint8Array) {
  const header = parseSourceHeader(content);
  if (!header) throw new Error('exported file had no parseable header');
  return header;
}

describe('StepExporter header overrides (options.* wins over source/default)', () => {
  it('options.description replaces the FILE_DESCRIPTION items entirely (not appended to source)', async () => {
    const store = await parse(SOURCE_MODEL);
    const result = new StepExporter(store).export({
      schema: store.schemaVersion,
      description: 'Caller Override Description',
    });
    const out = exportedHeader(result.content);
    expect(out.description).toEqual(['Caller Override Description']);
    // Proves it's a replacement, not a merge/append with the source item.
    expect(out.description).not.toContain('Source Description Item');
  });

  it('preserves a non-default source implementation_level through export', async () => {
    const store = await parse(SOURCE_MODEL);
    const result = new StepExporter(store).export({ schema: store.schemaVersion });
    const out = exportedHeader(result.content);
    // '3;7' is neither the generateHeader hardcoded default ('2;1') nor
    // anything a caller option sets — only the sourceHeader fallback wires it.
    expect(out.implementationLevel).toBe('3;7');
  });

  it('options.author replaces the FILE_NAME author slot (not merged with source author)', async () => {
    const store = await parse(SOURCE_MODEL);
    const result = new StepExporter(store).export({
      schema: store.schemaVersion,
      author: 'Caller Override Author',
    });
    const out = exportedHeader(result.content);
    expect(out.author).toEqual(['Caller Override Author']);
    expect(out.author).not.toContain('Source Author');
  });

  it('options.organization replaces the FILE_NAME organization slot (not merged with source organization)', async () => {
    const store = await parse(SOURCE_MODEL);
    const result = new StepExporter(store).export({
      schema: store.schemaVersion,
      organization: 'Caller Override Organization',
    });
    const out = exportedHeader(result.content);
    expect(out.organization).toEqual(['Caller Override Organization']);
    expect(out.organization).not.toContain('Source Organization');
  });

  it('carries a non-default source authorization token through export', async () => {
    const store = await parse(SOURCE_MODEL);
    const result = new StepExporter(store).export({ schema: store.schemaVersion });
    const out = exportedHeader(result.content);
    // '' is generateHeader's hardcoded default and there is no caller
    // option for authorization at all — only the sourceHeader fallback
    // wires this field, so a non-empty match proves that wiring.
    expect(out.authorization).toBe('source-authorization-token');
  });

  it('options.application overrides preprocessor_version but NOT originating_system', async () => {
    const store = await parse(SOURCE_MODEL);
    const result = new StepExporter(store).export({
      schema: store.schemaVersion,
      application: 'Caller Override Application',
    });
    const out = exportedHeader(result.content);
    // preprocessor_version: the option wins.
    expect(out.preprocessorVersion).toBe('Caller Override Application');
    // originating_system: untouched — still the source authoring tool, not
    // the caller's application and not the default 'ifc-lite'.
    expect(out.originatingSystem).toBe('Source Originating System');
  });

  it('options.filename replaces the FILE_NAME filename slot (not the source or default filename)', async () => {
    const store = await parse(SOURCE_MODEL);
    const result = new StepExporter(store).export({
      schema: store.schemaVersion,
      filename: 'caller-override.ifc',
    });
    const out = exportedHeader(result.content);
    expect(out.name).toBe('caller-override.ifc');
    expect(out.name).not.toBe('source-file.ifc');
    expect(out.name).not.toBe('export.ifc');
  });

  // The eighth override. Unlike the seven above, its default is not a constant
  // but the wall clock, so "differs from the default" cannot be asserted by
  // comparing against a fixed string. A timestamp in the past is distinct from
  // both the source header's and any clock-derived default by construction.
  it('options.timeStamp replaces the FILE_NAME timestamp slot (not the source or the wall clock)', async () => {
    const store = await parse(SOURCE_MODEL);
    const result = new StepExporter(store).export({
      schema: store.schemaVersion,
      timeStamp: '2011-11-11T11:11:11',
    });
    const out = exportedHeader(result.content);
    expect(out.timeStamp).toBe('2011-11-11T11:11:11');
    expect(out.timeStamp).not.toBe('2026-01-01T00:00:00');
  });

  // Control for the test above: with no override the slot must still be filled
  // from the clock, so a mutation that drops the override entirely cannot be
  // mistaken for "the field is simply never written".
  it('without options.timeStamp the slot is still populated', async () => {
    const store = await parse(SOURCE_MODEL);
    const result = new StepExporter(store).export({ schema: store.schemaVersion });
    const out = exportedHeader(result.content);
    expect(out.timeStamp).toBeTruthy();
    expect(out.timeStamp).not.toBe('2011-11-11T11:11:11');
  });
});
