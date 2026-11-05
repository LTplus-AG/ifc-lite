/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createBCFProject, createBCFTopic } from '@ifc-lite/bcf';
import { useViewerStore } from '@/store/index.js';
import { TooltipProvider } from '@/components/ui/tooltip';
import { registerLocale, setLocale, type Catalogue } from '@/i18n';
import type { TranslationValue } from '@/i18n/types';
import type { bcfEn as BcfEnType } from '@/i18n/catalogues/bcf.en';
import { BCFPanel } from './BCFPanel.js';
import { findPanelAction, runPanelAction } from '@/test/panel-header.js';
import { click, press } from '@/test/render.js';

let bcfEn: typeof BcfEnType | undefined;
try {
  ({ bcfEn } = await import('@/i18n/catalogues/bcf.en'));
} catch {
  bcfEn = undefined;
}

const CATALOGUE = bcfEn ?? ({} as typeof BcfEnType);
const marked = (text: string): string => `⟦${text}⟧`;

function pseudoLocale(): Catalogue {
  const catalogue: Record<string, TranslationValue> = {};
  for (const [key, value] of Object.entries(CATALOGUE)) {
    catalogue[key] =
      typeof value === 'string'
        ? marked(value)
        : (Object.fromEntries(
            Object.entries(value).map(([category, form]) => [category, marked(form as string)]),
          ) as TranslationValue);
  }
  return catalogue;
}

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

function renderPanel(): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <TooltipProvider>
        <BCFPanel onClose={() => {}} />
      </TooltipProvider>,
    );
  });
  mounted.push({ root, container });
  return container;
}

beforeEach(() => {
  setLocale('en');
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  const project = createBCFProject({ name: 'Test' });
  const topic = createBCFTopic({ title: 'A topic', author: 'a@b.com' });
  project.topics.set(topic.guid, topic);
  useViewerStore.setState({
    models: new Map(),
    bcfProject: project,
    activeTopicId: null,
    bcfError: null,
    bcfLoading: false,
    selectedEntityId: null,
    selectedEntityIds: new Set(),
    isolatedEntities: null,
    hiddenEntities: new Set(),
  });
});

afterEach(() => {
  setLocale('en');
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

describe('BCFPanel localization (#4918)', () => {
  it('uses upload for import and download for export (#5822)', () => {
    assert.ok(bcfEn, 'bcf.en.ts catalogue must exist');
    const container = renderPanel();
    for (const [titleKey, iconClass] of [
      ['bcf.panel.importTitle', 'lucide-upload'],
      ['bcf.panel.exportTitle', 'lucide-download'],
    ] as const) {
      const title = CATALOGUE[titleKey] as string;
      const button = [...container.querySelectorAll('button')].find((item) => item.getAttribute('aria-label') === title);
      assert.ok(button, `expected a button titled ${title}`);
      assert.ok(button.querySelector(`svg.${iconClass}`), `${title} should show ${iconClass}`);
    }
  });

  it('renders English header chrome by default', () => {
    assert.ok(bcfEn, 'bcf.en.ts catalogue must exist');
    const container = renderPanel();
    assert.match(container.textContent ?? '', /BCF Topics/);
  });

  it('updates the panel header titles and dialogs when the active locale changes', async () => {
    assert.ok(bcfEn, 'bcf.en.ts catalogue must exist');
    const container = renderPanel();
    registerLocale('bcf-panel-pseudo', pseudoLocale());
    act(() => setLocale('bcf-panel-pseudo'));

    assert.match(container.textContent ?? '', /⟦BCF Topics⟧/);
    const titles = [...container.querySelectorAll('[aria-label]')].map((el) => el.getAttribute('aria-label'));
    assert.ok(titles.includes(marked(CATALOGUE['bcf.panel.importTitle'] as string)));
    assert.ok(titles.includes(marked(CATALOGUE['bcf.panel.exportTitle'] as string)));
    // Set author is a header action; the shared header (#8802) lists it in More actions.
    assert.ok(await findPanelAction(container, marked(CATALOGUE['bcf.panel.setAuthorTitle'] as string)), 'expected a Set author action');
    await runPanelAction(container, marked(CATALOGUE['bcf.panel.setAuthorTitle'] as string));
    assert.match(document.body.textContent ?? '', /⟦Set Author Email⟧/);
    const authorInput = container.querySelector<HTMLInputElement>('input[aria-label]');
    assert.equal(authorInput?.getAttribute('aria-label'), marked(CATALOGUE['bcf.panel.authorEmailLabel'] as string));
  });

  it('translates the edit-topic form heading and submit label the panel passes as overrides (review #5055)', () => {
    assert.ok(bcfEn, 'bcf.en.ts catalogue must exist');
    const topic = useViewerStore.getState().bcfProject!.topics.values().next().value!;
    act(() => useViewerStore.setState({ activeTopicId: topic.guid }));
    const container = renderPanel();
    registerLocale('bcf-panel-edit-form-pseudo', pseudoLocale());
    act(() => setLocale('bcf-panel-edit-form-pseudo'));

    const editButton = [...container.querySelectorAll('button')].find(
      (b) => b.getAttribute('aria-label') === marked(CATALOGUE['bcf.topicDetail.editTopic'] as string),
    );
    assert.ok(editButton, 'expected an Edit topic button');
    act(() => {
      editButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    assert.match(container.textContent ?? '', new RegExp(marked(CATALOGUE['bcf.createForm.editTopicHeading'] as string)));
    assert.match(container.textContent ?? '', new RegExp(marked(CATALOGUE['bcf.createForm.saveChangesSubmitLabel'] as string)));
  });
});

describe('BCFPanel 3D markers toggle (#8802)', () => {
  /** The toggle's state as assistive tech reads it, inline or in More actions. */
  const stateOf = (control: HTMLElement): string | null =>
    control.getAttribute(control.tagName === 'BUTTON' ? 'aria-pressed' : 'aria-checked');

  it('keeps one name and reports shown or hidden through its pressed state only', async () => {
    act(() => useViewerStore.setState({ bcfOverlayVisible: false }));
    const container = renderPanel();
    const label = CATALOGUE['bcf.panel.showMarkers'] as string;

    const off = await findPanelAction(container, label);
    assert.ok(off, `expected a "${label}" action while markers are hidden`);
    assert.equal(stateOf(off), 'false');
    await runPanelAction(container, label);
    assert.equal(useViewerStore.getState().bcfOverlayVisible, true);

    const on = await findPanelAction(container, label);
    assert.ok(on, `expected the same "${label}" action while markers are shown`);
    assert.equal(stateOf(on), 'true');
    assert.equal(document.body.textContent?.includes('Hide 3D markers'), false);
    act(() => useViewerStore.setState({ bcfOverlayVisible: false }));
  });
});

describe('BCFPanel Import (#8802)', () => {
  it('opens the file picker inside the click, with no await before it (Safari drops a deferred input.click())', async () => {
    const container = renderPanel();
    const label = CATALOGUE['bcf.panel.importTitle'] as string;
    const control = await findPanelAction(container, label);
    assert.ok(control, `expected an "${label}" action`);

    const original = HTMLInputElement.prototype.click;
    let pickerOpens = 0;
    HTMLInputElement.prototype.click = function (this: HTMLInputElement) {
      if (this.type === 'file') pickerOpens += 1;
    };
    try {
      if (control.tagName === 'BUTTON') click(control);
      else press(control, 'Enter');
      // Read synchronously: a picker opened after any await has not run yet.
      assert.equal(pickerOpens, 1, 'the Import action opens the hidden file input within the same click');
    } finally {
      HTMLInputElement.prototype.click = original;
    }
  });
});
