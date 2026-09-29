/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, click, render } from '@/test/render';
import { GenerateAdvancedPanel } from './GenerateAdvancedPanel';

afterEach(cleanup);

it('#6329 gives each advanced schedule switch its visible name and keeps its action', () => {
  const changed: string[] = [];
  const view = render(<GenerateAdvancedPanel open onOpenChange={() => {}}
    strategy="IfcBuildingStorey" lagDays={0} predefinedType="CONSTRUCTION" scheduleName="Plan"
    linkSequences={false} skipEmptyGroups={false} createWorkPlan={false} workPlanName=""
    onChange={(key) => { changed.push(key); }}
    onCreateWorkPlanChange={() => { changed.push('createWorkPlan'); }} onWorkPlanNameChange={() => {}} />);
  const switches = [...view.querySelectorAll<HTMLButtonElement>('button[role="switch"]')];
  assert.equal(switches.length, 3);
  for (const control of switches) {
    const name = control.getAttribute('aria-label');
    assert.ok(name && view.textContent?.includes(name), 'switch name matches visible text');
    const id = control.id;
    assert.ok(id && view.querySelector(`label[for="${id}"]`), 'switch is associated with its label');
    assert.ok(document.getElementById(control.getAttribute('aria-describedby') ?? '')?.textContent?.trim(),
      'switch has a linked description');
  }
  const visibleLabel = view.querySelector<HTMLLabelElement>(`label[for="${switches[0]!.id}"]`);
  assert.ok(visibleLabel);
  click(visibleLabel);
  assert.deepEqual(changed, ['linkSequences']);
});
