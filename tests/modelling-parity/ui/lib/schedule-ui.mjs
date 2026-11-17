/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { scheduleTotal } from './measured-oracles.mjs';
/** Read displayed cells, not listResult quantities: stale UI must fail #9296. */
export async function readScheduleTotals(s) {
  const cells = await s.state(() => {
    const options = [...document.querySelectorAll('button[aria-label="Column options"]')];
    const index = options.findIndex(b => /^Length\b/.test(b.parentElement.innerText));
    if (index < 0) return { groups: [], total: '' };
    const groups = [...document.querySelectorAll('button[aria-pressed]')]
      .filter(b => b.parentElement.classList.contains('absolute') && b.parentElement.querySelector(':scope > button[aria-expanded]'))
      .map(b => b.children[index]?.querySelector('.font-mono')?.textContent ?? '');
    const footer = [...document.querySelectorAll('div.sticky')].find(d => /^Total\s*·/.test(d.textContent));
    return { groups, total: footer?.children[index]?.querySelector('.font-mono')?.textContent ?? '' };
  });
  return { groups: cells.groups.map(scheduleTotal), total: scheduleTotal(cells.total) };
}
