/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression: `count_entities` (group_by storey) and `get_entity` chained
 * `storey?.name ?? '(no storey)'` / `data.name ?? '(unnamed)'`, which only
 * fall through on null/undefined. A present-but-blank/whitespace-only
 * `IFCBUILDINGSTOREY`/`IfcWall` Name short-circuited the chain and was
 * emitted verbatim — a blank-labelled group in `count_entities`, and a
 * blank quoted name in `get_entity`'s text summary — instead of falling
 * through to the placeholder. Same family as #3515 (MCP material-name
 * fallback), reusing `firstNonBlank` from `packages/mcp/src/material-naming.ts`
 * (re-exported via `@ifc-lite/mcp/browser`).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { dispatch, parsePlaygroundModel } from './playground-dispatcher.js';

function ifc4(body: string): string {
  return [
    'ISO-10303-21;', 'HEADER;', "FILE_DESCRIPTION((''),'2;1');",
    "FILE_NAME('','',(''),(''),'','','');", "FILE_SCHEMA(('IFC4'));", 'ENDSEC;',
    'DATA;', body, 'ENDSEC;', 'END-ISO-10303-21;', '',
  ].join('\n');
}

const PREAMBLE = `
#1= IFCPROJECT('0Proj000000000000000001',$,'Proj',$,$,$,$,(#20),#30);
#20= IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#21,$);
#21= IFCAXIS2PLACEMENT3D(#22,$,$);
#22= IFCCARTESIANPOINT((0.,0.,0.));
#30= IFCUNITASSIGNMENT((#31));
#31= IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#40= IFCLOCALPLACEMENT($,#21);`;

// A wall on a storey whose Name is blank, plus a control wall with a
// blank Name of its own (for get_entity's name-fallback path).
const BLANK_STOREY_MODEL = ifc4(`${PREAMBLE}
#42= IFCBUILDINGSTOREY('0Storey00000000000001',$,'',$,$,#40,$,$,.ELEMENT.,0.);
#72= IFCWALL('0Wall000000000000000001',$,'',$,$,#40,$,'tag',$);
#80= IFCRELCONTAINEDINSPATIALSTRUCTURE('0RelCont0000000000001',$,$,$,(#72),#42);
`);

async function load(ifc: string) {
  return parsePlaygroundModel(new TextEncoder().encode(ifc).buffer as ArrayBuffer, 'fixture.ifc');
}

describe('playground count_entities group_by storey — blank storey Name', () => {
  it('falls a blank storey Name through to "(no storey)", not a blank group label', async () => {
    const model = await load(BLANK_STOREY_MODEL);
    const result = await dispatch(model, 'count_entities', { group_by: 'storey' });
    assert.equal(result.isError, false, `count_entities should not error: ${result.text}`);
    const structured = result.structured as { groups: Array<{ key: string; count: number }> };
    const keys = structured.groups.map((g) => g.key);
    assert.ok(!keys.includes(''), `expected no empty-string group key, got: ${JSON.stringify(keys)}`);
    assert.ok(keys.includes('(no storey)'), `expected "(no storey)" fallback, got: ${JSON.stringify(keys)}`);
  });
});

describe('playground get_entity — blank entity Name', () => {
  it('falls a blank entity Name through to "(unnamed)" in the text summary', async () => {
    const model = await load(BLANK_STOREY_MODEL);
    const result = await dispatch(model, 'get_entity', { global_id: '0Wall000000000000000001' });
    assert.equal(result.isError, false, `get_entity should not error: ${result.text}`);
    assert.ok(result.text.includes("'(unnamed)'"), `expected "(unnamed)" in text, got: ${result.text}`);
    assert.ok(!result.text.includes("''"), `expected no blank-quoted name, got: ${result.text}`);
  });
});
