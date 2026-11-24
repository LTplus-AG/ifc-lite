/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { render, click, cleanup } from '@/test/render.js';
import { RetainedEngineDetails } from './RetainedEngineDetails.js';

function manifestResponse(revision: string): Response {
  return new Response(JSON.stringify({ sdk: { revision } }), { status: 200, headers: { ETag: '"abc"' } });
}

async function flush(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

describe('RetainedEngineDetails stale manifest answer', () => {
  afterEach(cleanup);

  it('a manifest answer that arrives after the disclosure was closed does not reopen it', async () => {
    const pending: Array<(response: Response) => void> = [];
    const fetcher = (() => new Promise<Response>((resolve) => { pending.push(resolve); })) as unknown as typeof fetch;
    const ui = render(<RetainedEngineDetails fetcher={fetcher} />);
    const button = ui.querySelector('button')!;
    click(button); // open: request 1 in flight
    assert.equal(button.getAttribute('aria-expanded'), 'true');
    click(button); // close before it answers
    assert.equal(button.getAttribute('aria-expanded'), 'false');
    pending[0](manifestResponse('rev-1'));
    await flush();
    assert.equal(button.getAttribute('aria-expanded'), 'false', 'the closed panel must stay closed');
  });

  it('an older answer does not overwrite the loading state of a newer open', async () => {
    const pending: Array<(response: Response) => void> = [];
    const fetcher = (() => new Promise<Response>((resolve) => { pending.push(resolve); })) as unknown as typeof fetch;
    const ui = render(<RetainedEngineDetails fetcher={fetcher} />);
    const button = ui.querySelector('button')!;
    click(button); click(button); click(button); // open, close, open again: two requests
    pending[1](manifestResponse('rev-new'));
    await flush();
    pending[0](new Response('', { status: 500 }));
    await flush();
    assert.match(ui.textContent ?? '', /sdkRevision/);
    assert.doesNotMatch(ui.textContent ?? '', /engineUnavailable/, 'the superseded request failed late and must not replace the newer answer');
  });
});
