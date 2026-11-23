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
  const data = [{ label: 'a', value: 1 }, { label: 'b', value: 50 }, { label: 'c', value: 2 }, { label: 'd', value: 40 }];
  const chart = ifcComponents.GroupChart({ data, maxGroups: 3 }, () => {});
  const labels = [...chart.querySelectorAll('li')].map((li) => li.textContent?.replace(/\s*\(.*$/, ''));
  expect(labels).toEqual(['b', 'd', 'Other']);
});
