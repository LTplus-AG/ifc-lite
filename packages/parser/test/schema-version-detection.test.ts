/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Coverage for `detectSchemaVersion()` (columnar-parser.ts), which reads the
 * `FILE_SCHEMA` token out of the STEP header and classifies it via an
 * ordered ladder of `.includes()` checks:
 *
 *   if (headerText.includes('IFC5'))    return 'IFC5';
 *   if (headerText.includes('IFC4X3'))  return 'IFC4X3';
 *   if (headerText.includes('IFC4'))    return 'IFC4';
 *   if (headerText.includes('IFC2X3'))  return 'IFC2X3';
 *   return 'IFC4'; // default fallback
 *
 * The ORDER is load-bearing: 'IFC4X3'.includes('IFC4') is true, so the
 * IFC4X3 check must run before the IFC4 check or every IFC4X3 file
 * silently misdetects as IFC4. No existing test drives a real IFC4X3-headed
 * buffer through the public `parseLite()` entry point and asserts
 * `schemaVersion` — the other IFC4X3 references in this package
 * (inheritance-chain-equivalence, instantiable-across-schemas) exercise the
 * entity-dictionary tables, not header detection. Swapping the IFC4X3/IFC4
 * lines survives the full test suite before this file.
 *
 * `detectSchemaVersion` is module-private; this exercises it exclusively
 * through the public `ColumnarParser.parseLite()` entry point rather than
 * exporting it, since the whole point of the ladder is what schemaVersion
 * a real caller observes on the resulting store.
 */

import { describe, it, expect } from 'vitest';
import { StepTokenizer } from '../src/tokenizer.js';
import { ColumnarParser } from '../src/columnar-parser.js';
import type { EntityRef } from '../src/types.js';

function scan(ifc: string): { source: Uint8Array; entityRefs: EntityRef[] } {
  const source = new TextEncoder().encode(ifc);
  const tokenizer = new StepTokenizer(source);
  const entityRefs: EntityRef[] = [];
  for (const ref of tokenizer.scanEntitiesFast()) {
    entityRefs.push({
      expressId: ref.expressId,
      type: ref.type,
      byteOffset: ref.offset,
      byteLength: ref.length,
      lineNumber: ref.line,
    });
  }
  return { source, entityRefs };
}

function buildStep(schemaToken: string): string {
  return [
    'ISO-10303-21;',
    'HEADER;',
    "FILE_DESCRIPTION(('schema detection test'),'2;1');",
    "FILE_NAME('','',(''),(''),'','','');",
    `FILE_SCHEMA(('${schemaToken}'));`,
    'ENDSEC;',
    'DATA;',
    "#1=IFCPROJECT('proj-gid',$,'Project',$,$,$,$,$,$);",
    'ENDSEC;',
    'END-ISO-10303-21;',
    '',
  ].join('\n');
}

async function detect(schemaToken: string) {
  const { source, entityRefs } = scan(buildStep(schemaToken));
  const parser = new ColumnarParser();
  const store = await parser.parseLite(source.buffer.slice(0) as ArrayBuffer, entityRefs, {});
  return store.schemaVersion;
}

describe('detectSchemaVersion via ColumnarParser.parseLite (FILE_SCHEMA header)', () => {
  it('detects IFC4X3 — the critical ordering case ("IFC4X3".includes("IFC4") is true)', async () => {
    expect(await detect('IFC4X3')).toBe('IFC4X3');
  });

  it('detects plain IFC4', async () => {
    expect(await detect('IFC4')).toBe('IFC4');
  });

  it('detects IFC2X3', async () => {
    expect(await detect('IFC2X3')).toBe('IFC2X3');
  });

  it('detects IFC5', async () => {
    expect(await detect('IFC5')).toBe('IFC5');
  });

  it('falls back to IFC4 for an unrecognized schema token (matches none of the ladder substrings)', async () => {
    // Deliberately contains none of 'IFC5', 'IFC4X3', 'IFC4', 'IFC2X3' as
    // substrings, so this exercises the trailing `return 'IFC4'` default,
    // not the 'IFC4' `.includes()` branch above it.
    expect(await detect('IFC2X2')).toBe('IFC4');
  });
});
