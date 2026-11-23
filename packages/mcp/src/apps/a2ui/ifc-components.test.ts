/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Window } from 'happy-dom';
import { beforeAll, expect, it } from 'vitest';

let ifcComponents: typeof import('./ifc-components.js').ifcComponents;

beforeAll(async () => {
  const window = new Window();
  Object.assign(globalThis, { document: window.document });
  ({ ifcComponents } = await import('./ifc-components.js'));
});

it('folds chart groups like the viewer: the largest maxGroups - 1, then Other (#11344)', () => {
  const data = [
    { label: 'a', value: 1, refs: ['m:1'] }, { label: 'b', value: 50, refs: ['m:2'] },
    { label: 'c', value: 2, refs: ['m:3'] }, { label: 'd', value: 40, refs: ['m:4'] },
  ];
  const acts: { action: string; targets: unknown[] }[] = [];
  const chart = ifcComponents.GroupChart({ data, maxGroups: 3 }, (action, targets) => { acts.push({ action, targets }); });
  const labels = [...chart.querySelectorAll('li')].map((li) => li.textContent);
  expect(labels).toEqual(['b (50)', 'd (40)', 'Other (3)']);
  // Other carries the folded groups' total and their refs, so picking it selects a and c.
  (chart.querySelectorAll('button')[2] as unknown as { click(): void }).click();
  expect(acts).toEqual([{ action: 'select', targets: ['m:1', 'm:3'] }]);
});
