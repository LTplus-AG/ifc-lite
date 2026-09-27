/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5840 — the first-run card's primary action is "Load demo project", and
 * it goes through the SAME `loadFile` every other open uses (not a bus event
 * or a second pipeline). The Open button names model files, not ".ifc", and
 * the formats under it come from the one extension list.
 */
import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, click, render } from '@/test/render.js';
import { viewportLightingEn } from '@/i18n/catalogues/viewport-lighting.en';
import { MODEL_FILE_EXTENSIONS } from '@/services/supported-model-files';
import { ViewportWelcomeCard } from './ViewportWelcomeCard.js';

const DEMO_LABEL = viewportLightingEn['viewportLighting.container.emptyState.loadDemo.button'] as string | undefined;

function buttonWithText(container: HTMLElement, text: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
}

function renderCard(loadFile: (file: File) => Promise<void>, supported = true) {
  return render(
    <ViewportWelcomeCard
      webgpu={{ supported, checking: false }}
      onOpenClick={() => undefined}
      onStartBlank={() => undefined}
      recentFiles={[]}
      loadFile={loadFile}
    />,
  );
}

const realFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

describe('first-run card (#5840)', () => {
  it('offers "Load demo project" as the first button on the card', () => {
    assert.equal(typeof DEMO_LABEL, 'string', 'the demo label must be a catalogue string');
    const card = renderCard(() => Promise.resolve());
    const first = card.querySelector('button');
    assert.equal(first?.textContent?.trim(), DEMO_LABEL, 'the demo action must be the card\'s first (primary) button');
  });

  it('keeps a visible keyboard focus indicator on the primary action (#5826)', () => {
    const card = renderCard(() => Promise.resolve());
    const primary = buttonWithText(card, DEMO_LABEL ?? '');
    assert.ok(primary, 'the welcome primary action must render');
    assert.match(primary.className, /\bfocus-visible:ring-1\b/);
    assert.match(primary.className, /\bfocus-visible:ring-ring\b/);
  });

  it('loads the demo sample through the canonical loadFile', async () => {
    const fetched: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      fetched.push(String(input));
      return new Response(new Blob(['ISO-10303-21;']), { status: 200 });
    }) as typeof fetch;
    const loaded: File[] = [];
    const card = renderCard(async (file) => { loaded.push(file); });

    const button = buttonWithText(card, DEMO_LABEL ?? '');
    assert.ok(button, 'Load demo project button is rendered');
    click(button);
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

    assert.deepEqual(fetched, ['/samples/building-architecture.ifc']);
    assert.equal(loaded.length, 1, 'loadFile called once');
    assert.equal(loaded[0].name, 'building-architecture.ifc');
  });

  it('disables the demo action without WebGPU, like every other action', () => {
    const card = renderCard(() => Promise.resolve(), false);
    assert.equal(buttonWithText(card, DEMO_LABEL ?? '')?.disabled, true);
  });

  it('names model files, not ".ifc", and lists every supported format', () => {
    const open = viewportLightingEn['viewportLighting.container.emptyState.openButton.open'] as string;
    assert.doesNotMatch(open, /\.ifc\b/, 'the picker accepts more than .ifc');
    const card = renderCard(() => Promise.resolve());
    const text = card.textContent ?? '';
    for (const ext of MODEL_FILE_EXTENSIONS) assert.ok(text.includes(ext), `${ext} is listed on the card`);
  });
});
