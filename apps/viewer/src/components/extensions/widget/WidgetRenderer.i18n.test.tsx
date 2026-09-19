/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The widget DSL renderer's own chrome reads the i18n catalogue (#4918):
 * `WidgetRenderer.tsx` / `WidgetRendererNodes.tsx` (split under the
 * ~400-line house rule; both render `extensionsPanels.widgetRenderer.*`
 * keys) and `WidgetErrorBoundary.tsx` (`extensionsPanels.widgetErrorBoundary.*`).
 *
 * `WidgetNode` fields (`label`, `text`, `heading`, `body`, `message`, …)
 * are extension-authored DSL payload content, not literals in this repo
 * — this oracle only exercises the renderer's own empty-state / retry /
 * unknown-node / chart-label / crash-banner strings, same "PANEL'S OWN
 * chrome only" scope the rest of the #4918 sweep uses.
 *
 * Same oracle shape as `shared-commands.i18n.test.tsx`: a pseudo-locale
 * marks every English string across both catalogue slices, each surface
 * is mounted in a state that shows it, the locale is switched live, and
 * every marked string that was readable in English must reappear marked.
 */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import type { WidgetNode } from '@ifc-lite/extensions';
import { cleanup, render } from '@/test/render.js';
import { registerLocale, setLocale, type Catalogue } from '@/i18n';
import { extensionsPanelsEn } from '@/i18n/catalogues/extensions-panels.en';
import { WidgetRenderer, type WidgetRendererContext } from './WidgetRenderer.js';
import { WidgetErrorBoundary } from './WidgetErrorBoundary.js';

type ExtKey = keyof typeof extensionsPanelsEn;
const ALL_KEYS = Object.keys(extensionsPanelsEn) as ExtKey[];
const SCOPE_KEYS = ALL_KEYS.filter(
  (key) => key.startsWith('extensionsPanels.widgetRenderer.') || key.startsWith('extensionsPanels.widgetErrorBoundary.'),
);
const STATIC_KEYS = SCOPE_KEYS.filter((key) => {
  const value = extensionsPanelsEn[key];
  return typeof value === 'string' && !value.includes('{');
});

const mark = (key: ExtKey) => `⟦${key}|${String(extensionsPanelsEn[key])}⟧`;
const PSEUDO: Catalogue = Object.fromEntries(ALL_KEYS.map((key) => [key, mark(key)])) as Catalogue;

function readableText(container: HTMLElement): string {
  return container.textContent ?? '';
}

const CTX: WidgetRendererContext = { state: {} };

function ThrowingChild(): never {
  throw new Error('boom');
}

/** One tree exercising every static widgetRenderer key in a single
 *  render: an empty Table, an empty EntityList, a Chart (interpolated
 *  variant), an ErrorBanner with a retry command, and an unrecognized
 *  node type for the `UnknownNode` fallback. */
function widgetTree(): WidgetNode {
  return {
    type: 'Stack',
    children: [
      { type: 'Table', columns: [{ field: 'a', title: 'A' }], data: '$.missing' },
      { type: 'EntityList', data: '$.missing', idField: 'id' },
      { type: 'Chart', variant: 'bar', data: '$.missing' },
      { type: 'ErrorBanner', message: 'Something failed', retryCommand: 'cmd.retry' },
      { type: 'Bogus' } as unknown as WidgetNode,
    ],
  } as WidgetNode;
}

beforeEach(() => {
  setLocale('en');
});

afterEach(() => {
  cleanup();
  setLocale('en');
});

describe('Widget DSL renderer localization (#4918)', () => {
  it('translates every static widgetRenderer/widgetErrorBoundary key rendered', () => {
    const container = render(
      <div>
        <WidgetRenderer node={widgetTree()} ctx={CTX} />
        <WidgetErrorBoundary label="ext-a/widget-a">
          <ThrowingChild />
        </WidgetErrorBoundary>
      </div>,
    );
    const english = readableText(container);

    registerLocale('widget-renderer-pseudo', PSEUDO);
    act(() => setLocale('widget-renderer-pseudo'));
    const after = readableText(container);

    const covered: ExtKey[] = [];
    for (const key of STATIC_KEYS) {
      const text = String(extensionsPanelsEn[key]);
      if (!english.includes(text)) continue;
      assert.ok(after.includes(mark(key)), `${key}: "${text}" must be translated, marked text not found`);
      covered.push(key);
    }

    // Every static key in scope is exercised by this single fixture.
    assert.deepEqual(
      [...STATIC_KEYS].sort(),
      [...covered].sort(),
      'a widgetRenderer/widgetErrorBoundary key was not rendered by this fixture',
    );
  });

  it('interpolates the chart label and crash banner under a live locale switch', () => {
    registerLocale('widget-renderer-fr', {
      'extensionsPanels.widgetRenderer.chartLabel': '{variant} graphique (fr)',
      'extensionsPanels.widgetErrorBoundary.crashed': '{label} a planté (fr)',
    } as Catalogue);
    setLocale('widget-renderer-fr');

    const container = render(
      <div>
        <WidgetRenderer node={{ type: 'Chart', variant: 'line', data: '$.missing' } as WidgetNode} ctx={CTX} />
        <WidgetErrorBoundary label="ext-b/widget-b">
          <ThrowingChild />
        </WidgetErrorBoundary>
      </div>,
    );

    assert.match(readableText(container), /line graphique \(fr\)/);
    assert.match(readableText(container), /ext-b\/widget-b a planté \(fr\)/);
  });
});
