/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5351: which `FILE_SCHEMA` identifier the TypeScript writers declare.
 *
 * When a writer CHOOSES the identifier (a conversion, a merged export), an
 * IFC4X3 target is declared as `IFC4X3_ADD2` (ISO 16739-1:2024), the schema
 * whose layouts ifc-lite writes. IfcOpenShell resolves the bare `IFC4X3`
 * token to a later development schema and rejects those layouts under it
 * (proven against IfcOpenShell by `ifcopenshell-schema-conformance.test.ts`).
 * A re-export that does not convert keeps the source's own token, whatever it
 * is, and every output here must read back as the IFC4X3 family.
 */

import { describe, expect, it } from 'vitest';
import { IfcParser, parseSourceHeader, type IfcDataStore } from '@ifc-lite/parser';
import { StepExporter } from './step-exporter.js';
import { MergedExporter } from './merged-exporter.js';

const enc = (s: string): ArrayBuffer => new TextEncoder().encode(s).buffer as ArrayBuffer;

function model(schemaToken: string): string {
  return `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [ReferenceView]'),'2;1');
FILE_NAME('m.ifc','2026-01-01T00:00:00',('A'),('O'),'App','System','');
FILE_SCHEMA(('${schemaToken}'));
ENDSEC;
DATA;
#1=IFCWALL('3wkd_mjInDCfOthy7w_A6V',$,'Wall',$,$,$,$,$,$);
ENDSEC;
END-ISO-10303-21;`;
}

async function parse(schemaToken: string): Promise<IfcDataStore> {
  return new IfcParser().parseColumnar(enc(model(schemaToken)));
}

/** The identifiers an exported file declares, and the family ifc-lite reads it as. */
async function declared(content: Uint8Array): Promise<{ ids: string[]; family: string }> {
  const header = parseSourceHeader(content);
  if (!header) throw new Error('exported file had no parseable header');
  const reread = await new IfcParser().parseColumnar(content.slice().buffer as ArrayBuffer);
  return { ids: header.schemaIdentifiers, family: reread.schemaVersion };
}

describe('FILE_SCHEMA identifier written for IFC4X3 output (#5351)', () => {
  it('a conversion to IFC4X3 declares IFC4X3_ADD2 and reads back as IFC4X3', async () => {
    const store = await parse('IFC4');
    const out = await declared(new StepExporter(store).export({ schema: 'IFC4X3' }).content);
    expect(out).toEqual({ ids: ['IFC4X3_ADD2'], family: 'IFC4X3' });
  });

  it('a conversion to any other family still declares the family name', async () => {
    const store = await parse('IFC4X3_ADD2');
    const out = await declared(new StepExporter(store).export({ schema: 'IFC4' }).content);
    expect(out).toEqual({ ids: ['IFC4'], family: 'IFC4' });
  });

  it('a non-converting re-export keeps the source token: IFC4X3_ADD2 stays IFC4X3_ADD2', async () => {
    const store = await parse('IFC4X3_ADD2');
    const out = await declared(new StepExporter(store).export({ schema: 'IFC4X3' }).content);
    expect(out).toEqual({ ids: ['IFC4X3_ADD2'], family: 'IFC4X3' });
  });

  it('a non-converting re-export keeps a bare IFC4X3 source token (header fidelity, not a rewrite)', async () => {
    const store = await parse('IFC4X3');
    const out = await declared(new StepExporter(store).export({ schema: 'IFC4X3' }).content);
    expect(out).toEqual({ ids: ['IFC4X3'], family: 'IFC4X3' });
  });

  it('a merged export to IFC4X3 declares IFC4X3_ADD2 and reads back as IFC4X3', async () => {
    const a = await parse('IFC4');
    const b = await parse('IFC4X3');
    const result = new MergedExporter([
      { id: 'a', name: 'A', dataStore: a },
      { id: 'b', name: 'B', dataStore: b },
    ]).export({ schema: 'IFC4X3' });
    expect(await declared(result.content)).toEqual({ ids: ['IFC4X3_ADD2'], family: 'IFC4X3' });
  });
});
