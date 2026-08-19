/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { act } from 'react';

import { render, click, cleanup } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { CustomBasemapEditor } from './CustomBasemapEditor.js';

const TEMPLATE = 'https://tiles.example.org/aerial/{z}/{x}/{y}.png';
const CREDIT = 'Imagery © Example National Mapping Agency, CC BY 4.0';

/** Set a React-controlled input the way a keystroke does. */
function typeInto(container: HTMLElement, label: string, value: string): void {
  const input = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  assert.ok(input, `no input labelled "${label}"`);
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype, 'value',
  )?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}

function saveButton(container: HTMLElement): HTMLButtonElement {
  const button = [...container.querySelectorAll('button')]
    .find((b) => /save basemap/i.test(b.textContent ?? ''));
  assert.ok(button, 'no save button');
  return button as HTMLButtonElement;
}

/** Click save and let the probe promise settle. */
async function save(container: HTMLElement): Promise<void> {
  click(saveButton(container));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

function alerts(container: HTMLElement): string {
  return [...container.querySelectorAll('[role="alert"]')].map((n) => n.textContent).join(' ');
}

let originalFetch: typeof fetch;

describe('CustomBasemapEditor (issue #2685)', () => {
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    useViewerStore.setState({ cesiumCustomBasemap: null });
    localStorage.clear();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    cleanup();
  });

  it('refuses to save without attribution, and says why', async () => {
    globalThis.fetch = (async () => new Response('', { status: 200 })) as typeof fetch;
    const ui = render(<CustomBasemapEditor />);
    typeInto(ui, 'Tile URL template', TEMPLATE);
    await save(ui);

    assert.strictEqual(useViewerStore.getState().cesiumCustomBasemap, null);
    assert.match(alerts(ui), /attribution is required/i);
  });

  it('refuses a URL that is not a tile template', async () => {
    globalThis.fetch = (async () => new Response('', { status: 200 })) as typeof fetch;
    const ui = render(<CustomBasemapEditor />);
    typeInto(ui, 'Tile URL template', 'https://tiles.example.org/aerial.png');
    typeInto(ui, 'Attribution', CREDIT);
    await save(ui);

    assert.strictEqual(useViewerStore.getState().cesiumCustomBasemap, null);
    assert.match(alerts(ui), /\{z\}/);
  });

  it('saves a valid basemap to the store', async () => {
    globalThis.fetch = (async () => new Response('', { status: 200 })) as typeof fetch;
    const ui = render(<CustomBasemapEditor />);
    typeInto(ui, 'Tile URL template', TEMPLATE);
    typeInto(ui, 'Attribution', CREDIT);
    typeInto(ui, 'Maximum zoom', '20');
    await save(ui);

    const saved = useViewerStore.getState().cesiumCustomBasemap;
    assert.ok(saved);
    assert.strictEqual(saved.url, TEMPLATE);
    assert.strictEqual(saved.credit, CREDIT);
    assert.strictEqual(saved.maximumLevel, 20);
    assert.strictEqual(alerts(ui), '');
  });

  it('tells the user the server refuses browser access when the tile fetch is rejected', async () => {
    // A tile server with no `Access-Control-Allow-Origin` rejects the fetch
    // opaquely — the failure that otherwise shows up as an empty globe.
    globalThis.fetch = (async () => { throw new TypeError('Failed to fetch'); }) as typeof fetch;
    const ui = render(<CustomBasemapEditor />);
    typeInto(ui, 'Tile URL template', TEMPLATE);
    typeInto(ui, 'Attribution', CREDIT);
    await save(ui);

    assert.match(alerts(ui), /does not allow browser access/i);
  });

  it('does not call the server a CORS failure when it answers with a status', async () => {
    globalThis.fetch = (async () => new Response('', { status: 404 })) as typeof fetch;
    const ui = render(<CustomBasemapEditor />);
    typeInto(ui, 'Tile URL template', TEMPLATE);
    typeInto(ui, 'Attribution', CREDIT);
    await save(ui);

    assert.doesNotMatch(alerts(ui), /does not allow browser access/i);
    assert.match(ui.textContent ?? '', /404/);
  });
});
