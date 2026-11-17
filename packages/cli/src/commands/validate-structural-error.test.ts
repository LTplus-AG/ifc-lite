/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A structural consistency pass that throws is reported as one warning,
 * and the other validate rules still run (#9668). Its own file because the
 * parser module is replaced for every test in it.
 */

import { describe, it, expect, vi } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';

vi.mock('@ifc-lite/parser', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ifc-lite/parser')>()),
  // A thrown non-Error, so the report must not rely on `.message`.
  structuralConsistencyIssues: () => { throw 'unreadable structural record'; },
}));

const { computeValidationIssues } = await import('./validate.js');

describe('validate: structural consistency that cannot run', () => {
  it('reports the failure instead of throwing, and keeps the other rules', async () => {
    const bytes = new TextEncoder().encode(`ISO-10303-21;HEADER;FILE_DESCRIPTION((''),'2;1');FILE_NAME('x.ifc','',(''),(''),'','','');FILE_SCHEMA(('IFC4'));ENDSEC;DATA;
#1=IFCPROJECT('0Project0000000000000a',$,'Project',$,$,$,$,$,$);
ENDSEC;END-ISO-10303-21;`);
    const issues = computeValidationIssues(await new IfcParser().parseColumnar(bytes.buffer as ArrayBuffer));
    expect(issues.find((issue) => issue.rule === 'structural-consistency')).toEqual({
      severity: 'warning', rule: 'structural-consistency',
      message: 'Structural consistency checks could not run: unreadable structural record',
    });
    expect(issues.some((issue) => issue.rule === 'required-entity')).toBe(true);
  });
});
