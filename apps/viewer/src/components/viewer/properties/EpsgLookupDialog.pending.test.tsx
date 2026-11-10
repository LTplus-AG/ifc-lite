/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { register } from 'node:module';
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import type { EpsgIndexEntry } from '@ifc-lite/data';
import { render, click, type, advance, cleanup, waitFor } from '@/test/render';

type LookupValue = EpsgIndexEntry | EpsgIndexEntry[] | undefined;
declare global { var __epsgLookupGate: ((query: string, actual: () => Promise<LookupValue>) => Promise<LookupValue> | undefined) | undefined; }
register('../../../test/epsg-lookup-gate.mjs', import.meta.url);
const { EpsgLookupDialog } = await import('./EpsgLookupDialog');
afterEach(() => { cleanup(); globalThis.__epsgLookupGate = undefined; });

for (const outcome of ['success', 'failure'] as const) test(`C-7 clearing input rejects a late local-index ${outcome}`, async () => {
  let finish!: () => Promise<void>;
  let held = false;
  const query = outcome === 'failure' ? 'no-such-crs-fixture' : '4326';
  globalThis.__epsgLookupGate = (value, actual) => {
    if (value !== query) return undefined;
    return new Promise<LookupValue>((resolve, reject) => {
      held = true;
      finish = async () => { if (outcome === 'failure') reject(new Error('retired index failure')); else resolve(await actual()); };
    });
  };
  const ui = render(<EpsgLookupDialog onSelect={() => {}} />);
  click(ui.querySelector('button')!);
  await waitFor(() => document.querySelectorAll('[role="dialog"] code').length > 1, 'starter list');
  const input = document.querySelector<HTMLInputElement>('[role="dialog"] input')!;
  type(input, query); await advance(300);
  assert.equal(held, true, 'the real lookup is held at its async boundary');
  assert.equal(document.querySelectorAll('[role="dialog"] .animate-spin').length, 1, 'pending lookup shows activity');
  type(input, '');
  await advance(0);
  await waitFor(() => document.querySelectorAll('[role="dialog"] code').length > 1, 'blank input restored starters');
  assert.equal(document.querySelectorAll('[role="dialog"] .animate-spin').length, 0, 'clearing retires the old activity indicator');
  await act(async () => finish()); await advance(0);
  assert.equal(document.querySelectorAll('[role="dialog"] code').length > 1, true, 'late completion cannot replace starters');
  assert.equal(document.body.textContent?.includes('Search unavailable'), false, 'late failure cannot show a stale error');
});
