/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The shared panel header (#8802 R3a): at most two inline actions, the rest
 * labelled in "More actions", and in a narrow dock the actions leave before
 * the title loses a character.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { advance, cleanup, press, render } from '@/test/render.js';
import { setLocale } from '@/i18n';
import { PanelHeader, type PanelHeaderAction } from './panel-header.js';
import { useTourStore } from '@/lib/tours/tour-store';
import { getTour } from '@/lib/tours/registry';
import { TOUR_ANCHORS, tourAnchor } from '@/lib/tours/anchors';

function actions(log: string[] = [], pressed?: boolean): PanelHeaderAction[] {
  return ['Import', 'Export', 'Server', 'Markers'].map((label) => ({
    id: label.toLowerCase(),
    label,
    icon: <svg />,
    onSelect: () => log.push(label),
    ...(label === 'Markers' ? { pressed } : {}),
  }));
}

const inlineLabels = (ui: HTMLElement) =>
  [...ui.querySelectorAll('button[data-panel-action]')].map((button) => button.getAttribute('aria-label'));

async function openOverflow(ui: HTMLElement): Promise<HTMLElement[]> {
  const more = ui.querySelector<HTMLElement>('button[aria-label="More actions"]');
  assert.ok(more, 'the overflow trigger renders');
  press(more, 'ArrowDown');
  await advance(10);
  return [...document.body.querySelectorAll<HTMLElement>('[role="menu"] [data-panel-action]')];
}

/** Gives the header a width and its title a natural width; happy-dom has no layout. */
function withLayout(headerWidth: number, titleWidth: number): () => void {
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  const names = ['clientWidth', 'scrollWidth', 'offsetWidth'];
  const saved = names.map((name) => [name, Object.getOwnPropertyDescriptor(proto, name)] as const);
  const size = (el: HTMLElement, name: string): number => {
    if (el.hasAttribute('data-panel-header')) return name === 'clientWidth' ? headerWidth : 0;
    if (el.tagName === 'H2') return titleWidth;
    return 0;
  };
  for (const name of names) {
    Object.defineProperty(proto, name, { configurable: true, get(this: HTMLElement) { return size(this, name); } });
  }
  return () => {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(proto, name, descriptor);
      else delete proto[name];
    }
  };
}

afterEach(() => { cleanup(); setLocale('en'); });

describe('PanelHeader (#8802)', () => {
  it('shows two actions inline and lists the rest, labelled, in More actions', async () => {
    const log: string[] = [];
    const ui = render(<PanelHeader title="BCF Topics" actions={actions(log)} onClose={() => {}} />);
    assert.equal(ui.querySelector('h2')?.textContent, 'BCF Topics');
    assert.deepEqual(inlineLabels(ui), ['Import', 'Export']);
    assert.ok(ui.querySelector('button[aria-label="Close"]'), 'one close control');
    const items = await openOverflow(ui);
    assert.deepEqual(items.map((item) => item.textContent), ['Server', 'Markers']);
    press(items[0], 'Enter');
    await advance(10);
    assert.deepEqual(log, ['Server'], 'a menu row runs its action');
  });

  it('a leading control takes one of the two inline places', () => {
    const ui = render(<PanelHeader title="Clash detection" leading={<button type="button">Re-run</button>} actions={actions()} />);
    assert.deepEqual(inlineLabels(ui), ['Import']);
  });

  it('a toggle hidden in the menu is a checked menu row', async () => {
    const ui = render(<PanelHeader title="BCF Topics" actions={actions([], true)} />);
    const markers = (await openOverflow(ui)).find((item) => item.textContent === 'Markers');
    assert.equal(markers?.getAttribute('role'), 'menuitemcheckbox');
    assert.equal(markers?.getAttribute('aria-checked'), 'true');
  });

  it('in a narrow dock the actions move into the menu before the title truncates', async () => {
    const restore = withLayout(180, 100);
    try {
      const ui = render(<PanelHeader icon={<svg />} title="BCF Topics" actions={actions()} onClose={() => {}} />);
      assert.deepEqual(inlineLabels(ui), [], 'no inline action is left');
      assert.equal(ui.querySelector('h2')?.textContent, 'BCF Topics', 'the title itself is never shortened');
      assert.equal((await openOverflow(ui)).length, 4, 'every action stays reachable');
    } finally {
      restore();
    }
  });

  it('a dock with room for one action keeps the first one inline', () => {
    const restore = withLayout(240, 100);
    try {
      const ui = render(<PanelHeader title="BCF Topics" actions={actions()} onClose={() => {}} />);
      assert.deepEqual(inlineLabels(ui), ['Import']);
    } finally {
      restore();
    }
  });
});

describe('PanelHeader during a guided tour (#8802)', () => {
  const exportStep = getTour('bcf')?.steps.findIndex((step) => step.anchor === TOUR_ANCHORS.bcfExport) ?? -1;
  const toured = (): PanelHeaderAction[] => actions().map((action) => (
    action.id === 'server' ? { ...action, data: tourAnchor(TOUR_ANCHORS.bcfExport) } : action
  ));
  afterEach(() => { useTourStore.setState({ status: 'idle', tourId: null, stepIndex: 0 }); });

  it('keeps the action the current step points at inline, even in a dock too narrow for any action', () => {
    assert.ok(exportStep >= 0, 'the BCF tour has a step anchored on BCF export');
    const restore = withLayout(180, 100);
    try {
      useTourStore.setState({ status: 'running', tourId: 'bcf', stepIndex: exportStep });
      const ui = render(<PanelHeader title="BCF Topics" actions={toured()} onClose={() => {}} />);
      assert.deepEqual(inlineLabels(ui), ['Server'], 'the toured action is the one inline control');
      assert.ok(ui.querySelector(`button[data-tour="${TOUR_ANCHORS.bcfExport}"]`), 'its live anchor is in the header, not in a closed menu');
    } finally {
      restore();
    }
  });

  it('leaves the order alone when no tour is running', () => {
    const restore = withLayout(240, 100);
    try {
      const ui = render(<PanelHeader title="BCF Topics" actions={toured()} onClose={() => {}} />);
      assert.deepEqual(inlineLabels(ui), ['Import']);
    } finally {
      restore();
    }
  });
});
