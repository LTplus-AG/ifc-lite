/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { jsonResponse } from '@/test/fetch-stub';
import { resolve, resolveEnglish } from '@/i18n/registry';
import { FALLBACK_TEXT, startHostedViewer, type HostStartDeps } from './host-start';
import type { ViewerRuntimeConfig } from './runtime-config';

const PAGE = 'https://host.example/viewer/?context=v1';

function root(): HTMLElement {
  const container = document.createElement('div');
  document.body.append(container);
  return container;
}

interface Recorded {
  mounted: ViewerRuntimeConfig[];
  prepared: number;
  reloads: number;
  localesStarted: number;
}

/** Deps whose viewer records what it would have been prepared and mounted with. */
function deps(fetch: typeof globalThis.fetch, overrides: Partial<HostStartDeps> = {}): HostStartDeps & Recorded {
  const recorded: HostStartDeps & Recorded = {
    mounted: [], prepared: 0, reloads: 0, localesStarted: 0,
    fetch,
    pageUrl: PAGE,
    loadViewer: async () => ({
      prepareViewer: () => { recorded.prepared += 1; },
      mountViewer: (_container, options) => { recorded.mounted.push(options.config); },
    }),
    reload: () => { recorded.reloads += 1; },
    loadTranslator: async () => { recorded.localesStarted += 1; return resolve; },
    ...overrides,
  };
  return recorded;
}

const answer = (body: unknown, status = 200) => (async () => jsonResponse(body, status)) as typeof globalThis.fetch;

/** A request that never answers unless its signal aborts it. */
const silent = ((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
  init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
})) as typeof globalThis.fetch;

/** Runs `body` with `console.error` captured, so expected failures do not flood the test log. */
async function withSilencedConsole<T>(body: () => Promise<T>): Promise<{ result: T; errors: unknown[][] }> {
  const errors: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { errors.push(args); };
  try {
    return { result: await body(), errors };
  } finally {
    console.error = original;
  }
}

afterEach(() => document.body.replaceChildren());

describe('starting a viewer whose build names a configuration URL', () => {
  it('prepares the viewer, then mounts it with the fetched configuration', async () => {
    const container = root();
    const d = deps(answer({ version: 1, features: { default: 'none', enable: ['privacy.notice'] } }));
    assert.equal(await startHostedViewer(container, '/config', d), true);
    assert.equal(d.prepared, 1);
    assert.deepEqual(d.mounted.map((config) => config.features), [{ default: 'none', enable: ['privacy.notice'], disable: undefined }]);
    assert.equal(d.localesStarted, 0, 'the viewer negotiates its own locale, with the host locale');
  });

  it('requests the configuration before the viewer code has arrived', async () => {
    let requested = false;
    let releaseCode: () => void = () => {};
    const d = deps((async () => { requested = true; return jsonResponse({ version: 1 }); }) as typeof globalThis.fetch, {
      loadViewer: () => new Promise((resolve) => {
        releaseCode = () => resolve({ prepareViewer: () => {}, mountViewer: () => {} });
      }),
    });
    const started = startHostedViewer(root(), '/config', d);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(requested, true, 'the request is out while the code still loads');
    releaseCode();
    assert.equal(await started, true);
  });

  it('leaves the root empty while the configuration loads, so the boot watchdog still covers a stalled viewer chunk', async () => {
    const container = root();
    let release: (response: Response) => void = () => {};
    const pending = (() => new Promise<Response>((resolve) => { release = resolve; })) as typeof globalThis.fetch;
    const started = startHostedViewer(container, '/config', deps(pending));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(container.childElementCount, 0);
    release(jsonResponse({ version: 1 }));
    assert.equal(await started, true);
  });

  for (const [what, fetch, code] of [
    ['the endpoint answers 500', answer({ version: 1 }, 500), 'status'],
    ['the answer has the wrong shape', answer({ version: 3 }), 'invalid'],
    ['the request fails', (async () => { throw new TypeError('Failed to fetch'); }) as typeof globalThis.fetch, 'unreachable'],
    ['the request never answers', silent, 'unreachable'],
  ] as const) {
    it(`does not mount when ${what}; it says so, translated, instead`, async () => {
      const container = root();
      const d = deps(fetch, { timeoutMs: 30 });
      const { result, errors } = await withSilencedConsole(() => startHostedViewer(container, '/config', d));
      assert.equal(result, false);
      assert.equal(d.mounted.length, 0, 'a restricted deployment must never fall back to the unconfigured viewer');
      assert.equal(d.localesStarted, 1, 'the error screen negotiates the browser languages first');
      const screen = container.querySelector('[data-viewer-config="error"]');
      assert.ok(screen, 'the failure is shown');
      assert.equal(screen.getAttribute('role'), 'alert');
      assert.match(screen.textContent ?? '', /The viewer could not start/);
      assert.match(screen.textContent ?? '', new RegExp(`Technical detail: ${code}`));
      assert.equal(errors.length, 1, 'the cause is logged for whoever runs the deployment');
      screen.querySelector('button')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      assert.equal(d.reloads, 1);
    });
  }

  it('leaves a viewer that failed to load to the boot watchdog: no screen, the root stays empty', async () => {
    const container = root();
    const d = deps(answer({ version: 1 }), {
      loadViewer: () => Promise.reject(new TypeError('Failed to fetch dynamically imported module: /assets/bootstrap-old.js')),
      watchdogGraceMs: 50,
    });
    const { result } = await withSilencedConsole(() => startHostedViewer(container, '/config', d));
    assert.equal(result, false);
    assert.equal(container.childElementCount, 0, 'the watchdog heals an empty root (pin cleared, bounded reload)');
    assert.equal(d.localesStarted, 0);
    await withSilencedConsole(() => new Promise((resolve) => setTimeout(resolve, 80))); // let the grace timer end inside the test
  });

  it('says the viewer could not be loaded, not the settings, when the watchdog did not heal it', async () => {
    const container = root();
    const d = deps(answer({ version: 1 }), {
      loadViewer: () => Promise.reject(new TypeError('Failed to fetch dynamically imported module: /assets/bootstrap-old.js')),
      watchdogGraceMs: 20,
    });
    await withSilencedConsole(async () => {
      await startHostedViewer(container, '/config', d);
      await new Promise((resolve) => setTimeout(resolve, 80));
    });
    const text = container.textContent ?? '';
    assert.match(text, /The viewer could not be loaded/);
    assert.doesNotMatch(text, /settings could not be loaded/);
    assert.match(text, /Technical detail: viewer-code/);
  });

  it('shows the error screen in English when its translations hang', async () => {
    const container = root();
    const d = deps(answer({ version: 1 }, 500), { loadTranslator: () => new Promise(() => {}), translatorTimeoutMs: 20 });
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      const { result } = await withSilencedConsole(() => startHostedViewer(container, '/config', d));
      assert.equal(result, false);
    } finally {
      console.warn = originalWarn;
    }
    assert.match(container.textContent ?? '', /The viewer could not start/);
  });

  it('shows the error screen in English when its translations fail to load too', async () => {
    const container = root();
    const d = deps(answer({ version: 1 }, 500), { loadTranslator: () => Promise.reject(new Error('chunk 404')) });
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args); };
    try {
      const { result } = await withSilencedConsole(() => startHostedViewer(container, '/config', d));
      assert.equal(result, false);
    } finally {
      console.warn = originalWarn;
    }
    assert.match(container.textContent ?? '', /The viewer could not start/);
    assert.match(container.textContent ?? '', /Technical detail: status/);
    assert.equal(container.querySelector('button')?.textContent, 'Reload');
    assert.equal(warnings.length, 1);
  });

  it('keeps its English fallback identical to the catalogue', () => {
    for (const [key, text] of Object.entries(FALLBACK_TEXT)) {
      assert.equal(text, resolveEnglish(key as keyof typeof FALLBACK_TEXT), key);
    }
  });

  it('refuses a configuration URL on another origin', async () => {
    const container = root();
    let asked = 0;
    const d = deps((async () => { asked += 1; return jsonResponse({}); }) as typeof globalThis.fetch);
    const { result } = await withSilencedConsole(() => startHostedViewer(container, 'https://elsewhere.example/config', d));
    assert.equal(result, false);
    assert.equal(asked, 0);
    assert.equal(d.mounted.length, 0);
    assert.match(container.textContent ?? '', /Technical detail: cross-origin/);
  });
});
