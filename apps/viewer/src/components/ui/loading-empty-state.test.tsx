/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { click, cleanup, render } from '@/test/render.js';
import { MessageSquare } from 'lucide-react';

afterEach(cleanup);

// The primitives are new in #5814. Assert their presence explicitly so the
// revert oracle reaches a test assertion when their files are removed.
async function loadSpinner() {
  const primitive = await import('./spinner.js').catch((error: unknown) => {
    if ((error as { code?: string }).code !== 'ERR_MODULE_NOT_FOUND') throw error;
    return null;
  });
  assert.ok(primitive, 'the shared spinner primitive must exist');
  return primitive;
}

async function loadEmptyState() {
  const primitive = await import('./empty-state.js').catch((error: unknown) => {
    if ((error as { code?: string }).code !== 'ERR_MODULE_NOT_FOUND') throw error;
    return null;
  });
  assert.ok(primitive, 'the shared empty-state primitive must exist');
  return primitive;
}

it('#5814 LoadingState announces its label once through a status region', async () => {
  const { LoadingState } = await loadSpinner();
  const host = render(<LoadingState label="Loading model details" />);
  const status = host.querySelector('output');
  assert.ok(status);
  assert.equal(status.textContent, 'Loading model details');
  assert.equal(status.querySelector('svg')?.getAttribute('aria-hidden'), 'true');
});

it('#5814 an inline Spinner is decorative inside a labelled button', async () => {
  const { Spinner } = await loadSpinner();
  const host = render(<button aria-label="Export model"><Spinner /></button>);
  const button = host.querySelector('button');
  assert.equal(button?.getAttribute('aria-label'), 'Export model');
  assert.equal(button?.querySelector('svg')?.getAttribute('aria-hidden'), 'true');
  assert.equal(button?.querySelector('output'), null);
});

it('#5814 a named Spinner announces standalone activity', async () => {
  const { Spinner } = await loadSpinner();
  const host = render(<Spinner label="Searching" size="sm" />);
  assert.equal(host.querySelector('output')?.textContent, 'Searching');
  assert.equal(host.querySelector('svg')?.getAttribute('aria-hidden'), 'true');
});

it('#5814 EmptyState renders its message and working action', async () => {
  const { EmptyState } = await loadEmptyState();
  let created = false;
  const host = render(
    <EmptyState
      icon={<MessageSquare />}
      title="No topics"
      description="Create a topic to share an issue."
      action={<button onClick={() => { created = true; }}>Create topic</button>}
    />,
  );
  assert.match(host.textContent ?? '', /No topics/);
  assert.match(host.textContent ?? '', /Create a topic to share an issue/);
  assert.ok(host.querySelector('[aria-hidden="true"] svg'));
  click(host.querySelector('button')!);
  assert.equal(created, true);
});
