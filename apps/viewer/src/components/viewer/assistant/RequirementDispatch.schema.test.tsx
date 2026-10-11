/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #7375: without the IFC schema's declared types no unit can be checked, so nothing is offered for dispatch. */

import '@/test/setup-dom.js';
// The Assistant chunk registers these strings; this test mounts the section on its own.
import '@/i18n/catalogues/semantic-assist.register';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { render, cleanup, waitFor } from '@/test/render';
import { parseSemanticRequirements } from '@/lib/semantic/assist/requirement-proposal';
import { reviewRequirements } from '@/lib/semantic/assist/requirement-review';
import { passagesOf } from '@/lib/semantic/assist/spans';
import { RequirementDispatch } from './RequirementDispatch';

afterEach(() => cleanup());

const SPEC = 'Every wall shall be at least 150 mm thick.';
const quote = 'at least 150 mm thick';
const REQUIREMENTS = { version: 1, kind: 'semantic.requirements', title: 'Walls', unsupported: [], requirements: [
  { id: 'R1', statement: 'Walls are at least 150 mm thick', appliesTo: { ifcClass: 'IfcWall' }, property: 'Qto_WallBaseQuantities.Width',
    operator: 'atLeast', value: 150, unit: 'mm', span: { source: 'S1', start: SPEC.indexOf(quote), end: SPEC.indexOf(quote) + quote.length, quote } },
] };

test('#7375 a schema that cannot be read is refused visibly, with nothing to dispatch', async () => {
  const proposal = parseSemanticRequirements(JSON.stringify(REQUIREMENTS));
  const passages = passagesOf('S1', SPEC);
  const ui = render(<RequirementDispatch proposal={proposal} review={reviewRequirements(proposal, passages)} passages={passages}
    loadSchema={() => Promise.reject(new Error('schema tables unavailable'))} />);
  await waitFor(() => /schema tables unavailable/.test(ui.textContent ?? ''), 'the failure shows');
  assert.match(ui.querySelector('[role="alert"]')?.textContent ?? '', /The IFC schema could not be read, so no requirement can be dispatched: schema tables unavailable/);
  assert.equal(ui.querySelectorAll('button').length, 0, 'nothing can be prepared');
});
