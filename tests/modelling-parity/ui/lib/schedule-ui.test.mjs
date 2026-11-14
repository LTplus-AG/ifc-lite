/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readScheduleTotals } from './schedule-ui.mjs';
const require = createRequire(new URL('../../../../apps/viewer/package.json', import.meta.url));
const { Window } = require('happy-dom');
test('#9296 displayed schedule totals are read by Length column, including refresh', async () => {
  const window = new Window();
  const old = globalThis.document;
  globalThis.document = window.document;
  try {
    document.body.innerHTML = `<div><button aria-pressed="true">Unrelated toolbar</button><button aria-expanded="false">Menu</button></div><div><button>Type</button><button aria-label="Column options"></button></div>
      <div><button>Length (m)</button><button aria-label="Column options"></button></div>
      <div class="group absolute"><button aria-expanded="true"></button><button aria-pressed="false"><span>WT-200</span><span><span class="font-mono">10.00</span></span></button></div>
      <div class="sticky"><div>Total · 2</div><div><span class="font-mono">10.00</span></div></div>`;
    const session = { state: fn => fn() };
    assert.deepEqual(await readScheduleTotals(session), { groups: [10], total: 10 });
    for (const span of document.querySelectorAll('.font-mono')) span.textContent = '11.00';
    assert.deepEqual(await readScheduleTotals(session), { groups: [11], total: 11 });
    document.querySelector('.sticky').remove();
    assert.ok(Number.isNaN((await readScheduleTotals(session)).total));
  } finally {
    globalThis.document = old;
    await window.happyDOM.close();
  }
});
