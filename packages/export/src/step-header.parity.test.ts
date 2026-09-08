/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * TypeScript half of the STEP `HEADER` cross-language parity pin.
 *
 * The Rust writer (`rust/export/src/step_header.rs`, exercised by
 * `rust/export/tests/step_header_parity.rs`) is held to the SAME fixture, so
 * the two cannot drift apart silently. Follows the precedent set by
 * `csv-cell.parity.test.ts` / `csv_cell_parity.rs`.
 *
 * The expectations in that fixture are written from ISO 10303-21 and from each
 * case's own source file, never copied from either implementation's output —
 * a test that compared the halves only to one another would go green the
 * moment they were wrong in the same way.
 *
 * This exists because the halves HAD drifted, in the direction this file does
 * not control: the Rust writer built its header entirely from defaults, so
 * `ifc-lite export --format step` replaced a file's authored MVD claim with a
 * different one and blanked FILE_NAME. This side already preserved the source
 * header; what it lacked was anything stopping the other side from not.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseSourceHeader } from '@ifc-lite/parser';
import { buildStepHeader, type StepHeaderOptions } from './step-header.js';

interface Vector {
  name: string;
  why: string;
  ifc: string;
  schema: string;
  options: {
    timeStamp?: string;
    description?: string;
    author?: string;
    organization?: string;
    application?: string;
    filename?: string;
  };
  expectedHeader: string[];
}

interface Fixture {
  about: string[];
  cases: Vector[];
}

// The fixture lives in the Rust crate so `include_str!` can reach it; this side
// resolves it relative to the source file. NOT guarded by `existsSync`: a
// missing fixture means the pin is not being enforced, which must fail loudly.
const fixturePath = fileURLToPath(
  new URL('../../../rust/export/tests/fixtures/step_header_vectors.json', import.meta.url),
);
const fixture: Fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));

/**
 * The header section: every line through the first `ENDSEC;`. `buildStepHeader`
 * already stops there, so this only strips the trailing blank line its template
 * literal leaves behind — but it is spelled out so both halves are compared
 * over the same span, whichever one changes shape first.
 */
function headerLines(header: string): string[] {
  const out: string[] = [];
  for (const line of header.split('\n')) {
    out.push(line);
    if (line.trimEnd() === 'ENDSEC;') break;
  }
  return out;
}

describe('the STEP header matches the shared cross-language vectors', () => {
  // Anti-vacuity. A fixture that shrank to nothing, or to nothing but
  // all-default headers, would pass over the exact regression this pins.
  it('the fixture carries cases that can distinguish a blanked header', () => {
    expect(fixture.cases.length).toBeGreaterThanOrEqual(3);

    const preservesAuthoredFields = fixture.cases.some(c => {
      const fileName = c.expectedHeader.find(l => l.startsWith('FILE_NAME(')) ?? '';
      // An authored author list, and an originating_system that is not the
      // 'ifc-lite' default — values that can only have come from the source.
      return !fileName.includes(",(''),") && !fileName.includes(",'ifc-lite','ifc-lite',");
    });
    expect(preservesAuthoredFields, 'no case carries an authored FILE_NAME field forward').toBe(
      true,
    );

    const assertsNonDefaultMvd = fixture.cases.some(c =>
      c.expectedHeader.some(
        l =>
          l.startsWith('FILE_DESCRIPTION(') &&
          !l.includes('Exported from ifc-lite') &&
          !l.includes("ViewDefinition [CoordinationView]'"),
      ),
    );
    expect(
      assertsNonDefaultMvd,
      'no case pins a FILE_DESCRIPTION item that could only be read from the source',
    ).toBe(true);
  });

  for (const v of fixture.cases) {
    it(`vector: ${v.name}`, () => {
      const source = parseSourceHeader(new TextEncoder().encode(v.ifc));
      // Field-for-field the same options the Rust half is given. An ABSENT
      // field means "whatever this side defaults to", never a spelled-out
      // value: spelling the defaults out is how two implementations' defaults
      // drift apart without a vector noticing.
      const options: StepHeaderOptions = {};
      if (v.options.timeStamp !== undefined) options.timeStamp = v.options.timeStamp;
      if (v.options.description !== undefined) options.description = v.options.description;
      if (v.options.author !== undefined) options.author = v.options.author;
      if (v.options.organization !== undefined) options.organization = v.options.organization;
      if (v.options.application !== undefined) options.application = v.options.application;
      if (v.options.filename !== undefined) options.filename = v.options.filename;

      // 0 modifications: the provenance item this side appends when it has
      // rewritten records has no counterpart on the Rust side, which counts a
      // different quantity. That gap is reported, not encoded here as
      // agreement — so the vectors pin the un-modified export.
      const got = headerLines(buildStepHeader(options, source, v.schema, 0));
      expect(got, v.why).toEqual(v.expectedHeader);
    });
  }
});
