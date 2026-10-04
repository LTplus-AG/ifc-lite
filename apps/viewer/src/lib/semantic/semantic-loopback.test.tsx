/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { after, afterEach, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { act } from 'react';
import { render, click, cleanup, advance, type as input } from '@/test/render';
import { SemanticPanel } from '@/components/viewer/SemanticPanel';
import { useSemanticSession } from './session';
import { pilotDocument } from './demo';
import { executeValidation } from './validation-job';

const initialSession = useSemanticSession.getState();
let origin = ''; let requests = 0; let pending: ServerResponse | undefined;
const server = createServer((request, response) => {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Content-Type', 'application/json');
  if (request.method === 'OPTIONS') { response.end(); return; }
  requests++;
  if (request.url === '/pending') { pending = response; return; }
  response.end(JSON.stringify(pilotDocument()));
});
before(async () => {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});
afterEach(() => {
  cleanup(); pending?.end(JSON.stringify(pilotDocument())); pending = undefined;
  useSemanticSession.setState(initialSession, true); localStorage.clear();
});
function label(ui: HTMLElement, text: string): HTMLLabelElement {
  const element = [...ui.querySelectorAll('label')].find(candidate => candidate.textContent?.startsWith(text));
  assert.ok(element, text); return element;
}
function field(ui: HTMLElement, text: string): HTMLInputElement {
  const element = label(ui, text).querySelector('input'); assert.ok(element); return element;
}
function button(ui: HTMLElement, text: string): HTMLButtonElement {
  const element = [...ui.querySelectorAll('button')].find(candidate => candidate.textContent === text);
  assert.ok(element, text); return element;
}
function mode(ui: HTMLElement, value: string) {
  const select = label(ui, 'Data source').querySelector('select'); assert.ok(select);
  act(() => { select.value = value; select.dispatchEvent(new window.Event('change', { bubbles: true })); });
}
function configure(path = '/records'): HTMLElement {
  const ui = render(<SemanticPanel validationExecutor={executeValidation} />);
  mode(ui, 'json'); input(field(ui, 'Endpoint URL'), origin + path);
  input(field(ui, 'Allow requests to hostname'), '127.0.0.1'); return ui;
}
function grant(ui: HTMLElement): HTMLInputElement { return field(ui, 'Allow local HTTP requests to'); }
async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 250; attempt++) {
    if (predicate()) return;
    await advance(20);
  }
  assert.ok(predicate(), 'Expected asynchronous viewer behavior to complete');
}

test('issue #6784: mounted viewer denies loopback before dispatch, then retrieves through the real explicitly granted HTTP provider', async () => {
  const ui = configure(); const start = requests;
  assert.equal(grant(ui).checked, false);
  assert.ok(label(ui, 'Allow local HTTP requests to').textContent?.includes(origin));
  click(button(ui, 'Load records'));
  await waitFor(() => Boolean(ui.querySelector('[role="alert"]')));
  assert.equal(requests, start); assert.equal(useSemanticSession.getState().document, undefined);
  click(grant(ui)); click(button(ui, 'Load records'));
  await waitFor(() => Boolean(useSemanticSession.getState().document));
  assert.equal(requests, start + 1);
  assert.equal(useSemanticSession.getState().document?.resources[0].id, pilotDocument().resources[0].id);
  assert.equal(ui.querySelector('[role="alert"]'), null);
  const serialized = useSemanticSession.getState().save();
  assert.ok(serialized.includes(origin + '/records')); assert.ok(!serialized.includes('loopbackHttpOrigin'));
  click(button(ui, 'Restore saved workspace')); assert.equal(grant(ui).checked, false);
  assert.equal(field(ui, 'Allow requests to hostname').value, '');
});

for (const revoke of ['uncheck', 'endpoint', 'host', 'mode', 'relay', 'restore', 'import', 'preset'] as const) {
  test(`issue #6784: ${revoke} revokes local authority and aborts a pending retrieval before it can publish`, async () => {
    const ui = configure('/pending');
    // Save an inert endpoint preset, then explicitly grant this live session.
    act(() => useSemanticSession.getState().setQueries([{ id: 'saved', endpoint: origin + '/pending', kind: 'json' }]));
    const serialized = useSemanticSession.getState().save();
    click(grant(ui)); click(button(ui, 'Load records'));
    await waitFor(() => Boolean(pending)); const response = pending; assert.ok(response);
    if (revoke === 'uncheck') click(grant(ui));
    else if (revoke === 'endpoint') input(field(ui, 'Endpoint URL'), origin + '/records');
    else if (revoke === 'host') input(field(ui, 'Allow requests to hostname'), 'localhost');
    else if (revoke === 'mode') mode(ui, 'sparql');
    else if (revoke === 'relay') input(field(ui, 'Authorized relay provider ID (optional)'), 'fixed');
    else if (revoke === 'restore') click(button(ui, 'Restore saved workspace'));
    else if (revoke === 'import') {
      mode(ui, 'local'); const textarea = label(ui, 'JSON records').querySelector('textarea'); assert.ok(textarea);
      input(textarea, serialized); click(button(ui, 'Import workspace from JSON input'));
    } else {
      const preset = [...ui.querySelectorAll('button')].find(candidate => candidate.textContent === `saved: ${origin}/pending`);
      assert.ok(preset); click(preset);
    }
    await waitFor(() => response.destroyed);
    response.end(JSON.stringify(pilotDocument())); await advance(20);
    assert.equal(useSemanticSession.getState().document, undefined);
    assert.equal(useSemanticSession.getState().retrievedAt, undefined);
    if (revoke !== 'import') assert.equal(grant(ui).checked, false);
  });
}

test('issue #6784: alternate loopback spellings do not offer a grant, while IPv6 shows its exact eligible origin', () => {
  const ui = configure();
  for (const endpoint of ['http://127.1:7200/data', 'http://2130706433:7200/data', 'http://localhost.evil.test:7200/data', 'https://127.0.0.1:7200/data']) {
    input(field(ui, 'Endpoint URL'), endpoint);
    assert.ok(![...ui.querySelectorAll('label')].some(candidate => candidate.textContent?.startsWith('Allow local HTTP requests to')));
  }
  input(field(ui, 'Endpoint URL'), 'http://[::1]:8890/sparql');
  assert.ok(label(ui, 'Allow local HTTP requests to').textContent?.includes('http://[::1]:8890'));
  assert.equal(grant(ui).checked, false);
});
