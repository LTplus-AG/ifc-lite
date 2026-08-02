/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Source HEADER round-trip fidelity.
 *
 * Contract: parsing an IFC file captures its verbatim `FILE_DESCRIPTION`
 * items, implementation_level, FILE_NAME fields, and the exact `FILE_SCHEMA`
 * token onto `dataStore.sourceHeader`; re-exporting (without mutations)
 * reproduces those `FILE_DESCRIPTION` items and the exact `FILE_SCHEMA`
 * token instead of a fresh ifc-lite header. When mutations exist, exactly one
 * honest provenance item is appended without removing the source items.
 *
 * All fixtures here are synthetic and carry no real-world identifiers.
 */

import { describe, expect, it } from 'vitest';
import {
  IfcParser,
  generateHeader,
  parseSourceHeader,
  type IfcDataStore,
} from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { StepExporter } from './step-exporter.js';

const enc = (s: string): ArrayBuffer => new TextEncoder().encode(s).buffer as ArrayBuffer;
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

/** A synthetic IFC4X3_ADD2 file with a multi-item FILE_DESCRIPTION whose
 *  items contain commas inside brackets (exercises quote/bracket-aware
 *  splitting) plus two authors. */
const IFC4X3_ADD2_MODEL = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [DesignTransferView]','ExporterIdentifiers [ProductGUID: 0aZ9, Build: 7]','CoordinateReference [CoordinateBase: Survey Point, ProjectSite: Origin]'),'2;1');
FILE_NAME('sample-add2.ifc','2026-01-01T00:00:00',('Author One','Author Two'),('Example Org'),'Vendor App 1.0','Vendor System 2.0','auth-token');
FILE_SCHEMA(('IFC4X3_ADD2'));
ENDSEC;
DATA;
#1=IFCWALL('3wkd_mjInDCfOthy7w_A6V',$,'Sample Wall',$,$,$,$,$,$);
ENDSEC;
END-ISO-10303-21;`;

const IFC2X3_COORDINATION_MODEL = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('sample-2x3.ifc','2026-01-01T00:00:00',('Author'),('Org'),'App','System','');
FILE_SCHEMA(('IFC2X3'));
ENDSEC;
DATA;
#1=IFCWALL('3wkd_mjInDCfOthy7w_A6V',$,'Sample Wall',$,$,$,$,$);
ENDSEC;
END-ISO-10303-21;`;

const IFC4_REFERENCE_MODEL = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [ReferenceView_V1.2]'),'2;1');
FILE_NAME('sample-ref.ifc','2026-01-01T00:00:00',('Author'),('Org'),'App','System','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCWALL('3wkd_mjInDCfOthy7w_A6V',$,'Sample Wall',$,$,$,$,$,$);
ENDSEC;
END-ISO-10303-21;`;

async function parse(model: string): Promise<IfcDataStore> {
  return new IfcParser().parseColumnar(enc(model));
}

/** Re-parse the HEADER of an exported byte stream. */
function exportedHeader(content: Uint8Array) {
  const header = parseSourceHeader(content);
  if (!header) throw new Error('exported file had no parseable header');
  return header;
}

describe('parseSourceHeader', () => {
  it('captures multi-item FILE_DESCRIPTION, FILE_NAME fields, and the exact FILE_SCHEMA token', async () => {
    const store = await parse(IFC4X3_ADD2_MODEL);
    const sh = store.sourceHeader;
    expect(sh).toBeDefined();
    expect(sh!.description).toEqual([
      'ViewDefinition [DesignTransferView]',
      'ExporterIdentifiers [ProductGUID: 0aZ9, Build: 7]',
      'CoordinateReference [CoordinateBase: Survey Point, ProjectSite: Origin]',
    ]);
    expect(sh!.implementationLevel).toBe('2;1');
    expect(sh!.author).toEqual(['Author One', 'Author Two']);
    expect(sh!.organization).toEqual(['Example Org']);
    expect(sh!.preprocessorVersion).toBe('Vendor App 1.0');
    expect(sh!.originatingSystem).toBe('Vendor System 2.0');
    expect(sh!.authorization).toBe('auth-token');
    // Exact token — NOT flattened to the coarse 'IFC4X3'.
    expect(sh!.schemaIdentifiers).toEqual(['IFC4X3_ADD2']);
    expect(store.schemaVersion).toBe('IFC4X3');
  });

  it('returns undefined for non-STEP input', () => {
    expect(parseSourceHeader(new TextEncoder().encode('not an ifc file'))).toBeUndefined();
  });
});

describe('StepExporter header round-trip (no mutations)', () => {
  it('reproduces FILE_DESCRIPTION items and the exact FILE_SCHEMA token verbatim', async () => {
    const store = await parse(IFC4X3_ADD2_MODEL);
    const result = new StepExporter(store).export({ schema: store.schemaVersion });
    const out = exportedHeader(result.content);

    expect(out.description).toEqual(store.sourceHeader!.description);
    expect(out.schemaIdentifiers).toEqual(['IFC4X3_ADD2']);
    expect(dec(result.content)).toContain("FILE_SCHEMA(('IFC4X3_ADD2'))");
    // No provenance item when nothing changed.
    expect(result.stats.newEntityCount + result.stats.modifiedEntityCount).toBe(0);
    expect(out.description.some((d) => d.includes('Re-exported by ifc-lite'))).toBe(false);
  });

  it('preserves an IFC2X3 CoordinationView header verbatim', async () => {
    const store = await parse(IFC2X3_COORDINATION_MODEL);
    const out = exportedHeader(
      new StepExporter(store).export({ schema: store.schemaVersion }).content,
    );
    expect(out.description).toEqual(['ViewDefinition [CoordinationView]']);
    expect(out.schemaIdentifiers).toEqual(['IFC2X3']);
  });

  it('preserves an IFC4 ReferenceView header verbatim', async () => {
    const store = await parse(IFC4_REFERENCE_MODEL);
    const out = exportedHeader(
      new StepExporter(store).export({ schema: store.schemaVersion }).content,
    );
    expect(out.description).toEqual(['ViewDefinition [ReferenceView_V1.2]']);
    expect(out.schemaIdentifiers).toEqual(['IFC4']);
  });

  it('keeps the source authoring tool as originating_system while marking ifc-lite as preprocessor', async () => {
    const store = await parse(IFC4X3_ADD2_MODEL);
    const out = exportedHeader(
      new StepExporter(store).export({ schema: store.schemaVersion }).content,
    );
    expect(out.originatingSystem).toBe('Vendor System 2.0');
    expect(out.preprocessorVersion).toBe('ifc-lite');
  });

  it('falls back to parsing source bytes when sourceHeader is absent (cache-restored store)', async () => {
    const store = await parse(IFC4X3_ADD2_MODEL);
    // Simulate a cache-restored store that carries `source` but not `sourceHeader`.
    const restored = { ...store, sourceHeader: undefined } as IfcDataStore;
    const out = exportedHeader(
      new StepExporter(restored).export({ schema: restored.schemaVersion }).content,
    );
    expect(out.description).toEqual(store.sourceHeader!.description);
    expect(out.schemaIdentifiers).toEqual(['IFC4X3_ADD2']);
  });
});

describe('StepExporter header provenance (with mutations)', () => {
  it('appends exactly one provenance item without removing source items', async () => {
    const store = await parse(IFC4X3_ADD2_MODEL);
    const mutationView = new MutablePropertyView(null, 'model-1');
    mutationView.setAttribute(1, 'Name', 'Renamed Wall');

    const result = new StepExporter(store, mutationView).export({
      schema: store.schemaVersion,
      applyMutations: true,
    });

    const modifications = result.stats.newEntityCount + result.stats.modifiedEntityCount;
    expect(modifications).toBeGreaterThan(0);

    const out = exportedHeader(result.content);
    const sourceItems = store.sourceHeader!.description;
    // Source items intact, in order, at the front.
    expect(out.description.slice(0, sourceItems.length)).toEqual(sourceItems);
    // Exactly one extra item, and it is the provenance line.
    expect(out.description).toHaveLength(sourceItems.length + 1);
    expect(out.description[out.description.length - 1]).toBe(
      `Re-exported by ifc-lite, ${modifications} modification${modifications === 1 ? '' : 's'}`,
    );
    // Schema token still exact.
    expect(out.schemaIdentifiers).toEqual(['IFC4X3_ADD2']);
  });
});

describe('StepExporter header round-trip (STEP string escapes)', () => {
  it('round-trips an ISO-10303-21 \\X2\\ author without doubling backslashes', async () => {
    const model = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('sample.ifc','2026-01-01T00:00:00',('Tr\\X2\\00FC\\X0\\mpler'),('Org'),'App','System','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCWALL('3wkd_mjInDCfOthy7w_A6V',$,'Sample Wall',$,$,$,$,$,$);
ENDSEC;
END-ISO-10303-21;`;
    const store = await parse(model);
    // Read decodes the STEP escape to real Unicode (ü), not literal text.
    expect(store.sourceHeader!.author).toEqual(['Trümpler']);

    const result = new StepExporter(store).export({ schema: store.schemaVersion });
    const text = dec(result.content);
    // The old bug re-encoded the (un-decoded) `\X2\` into doubled backslashes.
    expect(text).not.toContain('\\\\');

    const out = exportedHeader(result.content);
    expect(out.author).toEqual(['Trümpler']);
  });

  it('collapses a newline in a header value to a space (no split record)', () => {
    const header = generateHeader({ schema: 'IFC4', author: ['A\nB'], timeStamp: 'TS' });
    const parsed = parseSourceHeader(new TextEncoder().encode(header));
    expect(parsed).toBeDefined();
    expect(parsed!.author).toEqual(['A B']);
  });

  it('round-trips a literal backslash (C:\\temp) byte-stably across two write/read cycles', () => {
    // Regression (PR #1772 review): the writer doubles `\` to `\\` but the read
    // path preserved unknown doubled sequences, so `C:\temp` grew a backslash
    // on every round trip (`C:\\temp`, `C:\\\\temp`, ...).
    const opts = { schema: 'IFC4', timeStamp: 'TS', filename: 'f.ifc' } as const;
    const h1 = generateHeader({ ...opts, author: ['C:\\temp'] });
    expect(h1).toContain("'C:\\\\temp'"); // stored escaped, exactly one doubling

    const p1 = parseSourceHeader(new TextEncoder().encode(h1));
    expect(p1!.author).toEqual(['C:\\temp']);

    const h2 = generateHeader({ ...opts, author: p1!.author });
    expect(h2).toBe(h1);

    const p2 = parseSourceHeader(new TextEncoder().encode(h2));
    expect(p2!.author).toEqual(['C:\\temp']);
    expect(generateHeader({ ...opts, author: p2!.author })).toBe(h1);
  });

  it('does not mis-decode escaped literal directive text as a real \\X2\\ directive', () => {
    // `a\X2\0041\X0\b` as LITERAL text is stored `a\\X2\\0041\\X0\\b`; reading
    // it back must yield the literal text, not decode the payload to 'A'.
    const literal = 'a\\X2\\0041\\X0\\b';
    const header = generateHeader({ schema: 'IFC4', author: [literal], timeStamp: 'TS' });
    const parsed = parseSourceHeader(new TextEncoder().encode(header));
    expect(parsed!.author).toEqual([literal]);
  });

  it('decodes a literal backslash adjacent to a real directive', () => {
    // Raw STEP `\\\X2\00E4\X0\` = one literal backslash then a real directive.
    const header = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('f.ifc','TS',('\\\\\\X2\\00E4\\X0\\'),(''),'p','o','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
`;
    const parsed = parseSourceHeader(new TextEncoder().encode(header));
    expect(parsed!.author).toEqual(['\\ä']);
  });

  it('decodes a directive immediately FOLLOWED by an escaped backslash', () => {
    // Raw STEP `Tr\X2\00FC\X0\\\docs` = directive then one literal backslash
    // (three raw backslashes in a row: the directive terminator's, then the
    // `\\` pair). A split at every doubled backslash consumed the terminator,
    // leaving an unterminated `\X2\` that never decoded (logical value is
    // `Trü\docs`, e.g. a Windows path from another authoring tool).
    const header = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('f.ifc','TS',('Tr\\X2\\00FC\\X0\\\\\\docs'),(''),'p','o','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
`;
    const parsed = parseSourceHeader(new TextEncoder().encode(header));
    expect(parsed!.author).toEqual(['Trü\\docs']);

    // And it round-trips byte-stably through the writer.
    const opts = { schema: 'IFC4', timeStamp: 'TS', filename: 'f.ifc' } as const;
    const h1 = generateHeader({ ...opts, author: parsed!.author });
    const p1 = parseSourceHeader(new TextEncoder().encode(h1));
    expect(p1!.author).toEqual(['Trü\\docs']);
    expect(generateHeader({ ...opts, author: p1!.author })).toBe(h1);
  });
});

describe('generateHeader', () => {
  it('emits a valid default (scratch) header with a parenthesised description list', () => {
    const header = generateHeader({ schema: 'IFC4', timeStamp: 'TS' });
    expect(header).toBe(
      `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('output.ifc','TS',(''),(''),'ifc-lite','ifc-lite','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
`,
    );
  });

  it('serialises description/author arrays and preserves an exact schema token', () => {
    const header = generateHeader({
      schema: 'IFC4X3_ADD2',
      description: ['First item', 'Second item'],
      author: ['A One', 'A Two'],
      organization: ['Org'],
      originatingSystem: 'Source System',
      preprocessorVersion: 'ifc-lite',
      timeStamp: 'TS',
      filename: 'out.ifc',
    });
    expect(header).toContain("FILE_DESCRIPTION(('First item','Second item'),'2;1')");
    expect(header).toContain("FILE_NAME('out.ifc','TS',('A One','A Two'),('Org'),'ifc-lite','Source System','')");
    expect(header).toContain("FILE_SCHEMA(('IFC4X3_ADD2'))");
  });

  it('STEP-escapes apostrophes in description items', () => {
    const header = generateHeader({ schema: 'IFC4', description: ["O'Brien view"], timeStamp: 'TS' });
    expect(header).toContain("FILE_DESCRIPTION(('O''Brien view'),'2;1')");
  });
});
