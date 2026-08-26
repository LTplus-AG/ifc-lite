/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `parseSourceHeader` must locate `ENDSEC` and each `FILE_*` keyword as a
 * RECORD, never as a substring of a quoted header VALUE (issue #3284, item 1).
 *
 * ISO 10303-21 6.3.3.4 makes a string literal opaque text delimited by `'`
 * with `''` as the escape, so a `FILE_DESCRIPTION` item may legally contain
 * the characters `ENDSEC;` or `FILE_NAME` without either being a declaration.
 * A `toUpperCase().indexOf(...)` scan cannot tell the two apart, and both
 * failures erase provenance rather than reporting an error:
 *
 *   - a quoted `ENDSEC` truncated the header before ANY record was seen, so
 *     the function returned `undefined` and the exporter fell back to its
 *     defaults;
 *   - a quoted `FILE_NAME` matched first, the character after it was not `(`,
 *     `extractRecordArgs` returned `null`, and every FILE_NAME field (name,
 *     timestamp, author, organization, preprocessor, originating system,
 *     authorization) was lost.
 *
 * Schema detection is pinned separately in `schema-detection.test.ts` (#3278 /
 * #3279); this file pins the OTHER nine fields, which that test cannot see —
 * a header can carry the right `schemaIdentifiers` and still have lost its
 * author and originating system.
 *
 * `ifc_lite_export::step_text::find_outside_quotes` is the Rust half of the
 * same rule and the reference behaviour here.
 */

import { describe, expect, it } from 'vitest';

import { parseSourceHeader } from '../src/source-header.js';

/**
 * One header, one variable: the FILE_DESCRIPTION item's free text. Every other
 * byte is identical across the cases, so a difference in the parsed result can
 * only come from that text.
 */
function headerBytes(descriptionItem: string): Uint8Array {
  return new TextEncoder().encode(
    [
      'ISO-10303-21;',
      'HEADER;',
      `FILE_DESCRIPTION(('${descriptionItem}'),'2;1');`,
      "FILE_NAME('a.ifc','2026-08-26T00:00:00',('Jane'),('Acme'),'pp 1.0','SomeApp','auth');",
      "FILE_SCHEMA(('IFC4'));",
      'ENDSEC;',
      'DATA;',
      "#1=IFCPROJECT('0000000000000000000001',$,'P',$,$,$,$,$,$);",
      'ENDSEC;',
      'END-ISO-10303-21;',
      '',
    ].join('\n'),
  );
}

/**
 * The full field set the header above declares. NAMED, not counted: a test
 * that only checked "some fields survived" passes on a header that lost the
 * author and the originating system, which is exactly what #3284 item 1b did.
 */
const FULL_HEADER = {
  description: [] as string[], // per-case, filled in below
  implementationLevel: '2;1',
  name: 'a.ifc',
  timeStamp: '2026-08-26T00:00:00',
  author: ['Jane'],
  organization: ['Acme'],
  preprocessorVersion: 'pp 1.0',
  originatingSystem: 'SomeApp',
  authorization: 'auth',
  schemaIdentifiers: ['IFC4'],
};

/** Every field name the assertions below must account for. */
const REQUIRED_FIELDS = [
  'description',
  'implementationLevel',
  'name',
  'timeStamp',
  'author',
  'organization',
  'preprocessorVersion',
  'originatingSystem',
  'authorization',
  'schemaIdentifiers',
] as const;

describe('parseSourceHeader skips quoted text when locating records (#3284)', () => {
  /**
   * Negative control / bounding case: a description with no keyword-like text
   * must parse to exactly the same header as the hostile ones. Without this,
   * a fix that broke every header equally would still satisfy the two cases
   * below only if they were compared against each other.
   */
  it('parses every declared field from a plain header', () => {
    const header = parseSourceHeader(headerBytes('a plain description'));
    expect(header).toEqual({ ...FULL_HEADER, description: ['a plain description'] });
    // Anti-vacuity: the expectation above must cover the whole surface, so a
    // field added to IfcSourceHeader cannot slip in unasserted.
    expect(Object.keys(header ?? {}).sort()).toEqual([...REQUIRED_FIELDS].sort());
  });

  it('a quoted ENDSEC does not truncate the header away (#3284 item 1a)', () => {
    const descriptionItem = 'note: the ENDSEC; marker is described here';
    const header = parseSourceHeader(headerBytes(descriptionItem));
    // The whole-header erasure: this returned `undefined` before the fix.
    expect(header).toBeDefined();
    expect(header).toEqual({ ...FULL_HEADER, description: [descriptionItem] });
  });

  it('a quoted FILE_NAME does not shadow the real record (#3284 item 1b)', () => {
    const descriptionItem = 'per the FILE_NAME convention';
    const header = parseSourceHeader(headerBytes(descriptionItem));
    // Before the fix these seven were `undefined` / `[]` while description,
    // implementationLevel and schemaIdentifiers looked correct — which is why
    // the assertion has to name them rather than count surviving fields.
    expect(header?.name).toBe('a.ifc');
    expect(header?.timeStamp).toBe('2026-08-26T00:00:00');
    expect(header?.author).toEqual(['Jane']);
    expect(header?.organization).toEqual(['Acme']);
    expect(header?.preprocessorVersion).toBe('pp 1.0');
    expect(header?.originatingSystem).toBe('SomeApp');
    expect(header?.authorization).toBe('auth');
    expect(header).toEqual({ ...FULL_HEADER, description: [descriptionItem] });
  });

  it('a quoted FILE_DESCRIPTION does not shadow the real record either', () => {
    // The third keyword the same scan looks up, and the one whose shadowing
    // would be self-concealing: a lost FILE_DESCRIPTION leaves the default
    // implementation level '2;1', which is also the declared value here — so
    // the description text itself is what has to be asserted.
    const descriptionItem = "written by FILE_DESCRIPTION(('x'),''2;1'') itself";
    const header = parseSourceHeader(headerBytes(descriptionItem));
    expect(header?.description).toEqual(["written by FILE_DESCRIPTION(('x'),'2;1') itself"]);
    expect(header?.name).toBe('a.ifc');
  });

  it('still stops at the real ENDSEC and never reads the DATA section', () => {
    // The other direction of the same rule: quote-awareness must not turn the
    // terminator off. `#1=IFCPROJECT(...)` sits after ENDSEC with a quoted
    // 'P' name; if the scan ran past the terminator the description/name
    // fields would be unchanged but a second FILE_* record in DATA would win.
    const bytes = new TextEncoder().encode(
      [
        'ISO-10303-21;',
        'HEADER;',
        "FILE_DESCRIPTION(('real'),'2;1');",
        "FILE_NAME('real.ifc','ts',('Jane'),('Acme'),'pp','SomeApp','auth');",
        "FILE_SCHEMA(('IFC4'));",
        'ENDSEC;',
        'DATA;',
        "FILE_NAME('planted.ifc','ts2',('Mallory'),('Evil'),'p2','Other','a2');",
        "FILE_SCHEMA(('IFC2X3'));",
        'ENDSEC;',
        'END-ISO-10303-21;',
        '',
      ].join('\n'),
    );
    const header = parseSourceHeader(bytes);
    expect(header?.name).toBe('real.ifc');
    expect(header?.author).toEqual(['Jane']);
    expect(header?.schemaIdentifiers).toEqual(['IFC4']);
  });

  it('returns undefined for input with no header records at all', () => {
    // Negative control for the `undefined` return itself: it has to still mean
    // "no recognisable header", not "the scan tripped".
    expect(parseSourceHeader(new TextEncoder().encode('not a STEP file at all'))).toBeUndefined();
  });
});
