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

  it('updates the panel header titles and dialogs when the active locale changes', () => {
    assert.ok(bcfEn, 'bcf.en.ts catalogue must exist');
    const container = renderPanel();
    registerLocale('bcf-panel-pseudo', pseudoLocale());
    act(() => setLocale('bcf-panel-pseudo'));

    assert.match(container.textContent ?? '', /⟦BCF Topics⟧/);
    const titles = [...container.querySelectorAll('[aria-label]')].map((el) => el.getAttribute('aria-label'));
    assert.ok(titles.includes(marked(CATALOGUE['bcf.panel.importTitle'] as string)));
    assert.ok(titles.includes(marked(CATALOGUE['bcf.panel.exportTitle'] as string)));
    assert.ok(titles.includes(marked(CATALOGUE['bcf.panel.setAuthorTitle'] as string)));

    const setAuthorButton = [...container.querySelectorAll('button')].find(
      (b) => b.getAttribute('aria-label') === marked(CATALOGUE['bcf.panel.setAuthorTitle'] as string),
    );
    assert.ok(setAuthorButton, 'expected a Set author button');
    act(() => {
      setAuthorButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    assert.match(document.body.textContent ?? '', /⟦Set Author Email⟧/);
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
