/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, render } from '@/test/render.js';
import { registerLocale, setLocale, type Catalogue } from '@/i18n';
import type { TranslationValue } from '@/i18n/types';
import type { bcfEn as BcfEnType } from '@/i18n/catalogues/bcf.en';
import type { BCFTopic } from '@ifc-lite/bcf';
import { BCFTopicDetail } from './BCFTopicDetail.js';

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
        : Object.fromEntries(Object.entries(value).map(([category, form]) => [category, marked(form as string)])) as TranslationValue;
  }
  return catalogue;
}

function baseTopic(overrides: Partial<BCFTopic> = {}): BCFTopic {
  return {
    guid: 'topic-1',
    title: 'A topic',
    topicType: 'Issue',
    topicStatus: 'Open',
    comments: [],
    viewpoints: [],
    ...overrides,
  } as BCFTopic;
}

const noop = () => {};

beforeEach(() => setLocale('en'));
afterEach(() => {
  cleanup();
  setLocale('en');
});

describe('BCF topic detail localization (#4918)', () => {
  it('renders English chrome by default', () => {
    assert.ok(bcfEn, 'bcf.en.ts catalogue must exist');
    const ui = render(
      <BCFTopicDetail
        topic={baseTopic()}
        onBack={noop}
        onEditTopic={noop}
        onAddComment={noop}
        onAddViewpoint={noop}
        onAddSectionViewpoint={noop}
        sectionViewpointBlockReason={null}
        onActivateViewpoint={noop}
        onDeleteViewpoint={noop}
        onUpdateStatus={noop}
        onZoomToTopic={noop}
        canZoomToTopic={false}
        onDeleteTopic={noop}
        selectionCount={0}
        hasIsolation={false}
        hasHiddenEntities={false}
      />,
    );
    assert.match(ui.textContent ?? '', /Viewpoints/);
    assert.match(ui.textContent ?? '', /No viewpoints captured/);
    assert.match(ui.textContent ?? '', /Comments \(0\)/);
  });

  it('updates chrome, aria-labels, and interpolated states when the active locale changes', () => {
    assert.ok(bcfEn, 'bcf.en.ts catalogue must exist');
    const topic = baseTopic({
      creationAuthor: 'alice@example.com',
      creationDate: '2026-01-01T00:00:00Z',
      assignedTo: 'bob@example.com',
      dueDate: '2026-02-01',
    });
    const ui = render(
      <BCFTopicDetail
        topic={topic}
        onBack={noop}
        onEditTopic={noop}
        onAddComment={noop}
        onAddViewpoint={noop}
        onAddSectionViewpoint={noop}
        sectionViewpointBlockReason={null}
        onActivateViewpoint={noop}
        onDeleteViewpoint={noop}
        onUpdateStatus={noop}
        onZoomToTopic={noop}
        canZoomToTopic
        onDeleteTopic={noop}
        selectionCount={2}
        hasIsolation
        hasHiddenEntities={false}
      />,
    );
    registerLocale('bcf-topic-detail-pseudo', pseudoLocale());
    act(() => setLocale('bcf-topic-detail-pseudo'));

    const text = document.body.textContent ?? '';
    assert.match(text, /⟦Viewpoints⟧/);
    assert.match(text, /⟦Created by alice@example\.com on/);
    assert.match(text, /⟦Assigned to: bob@example\.com⟧/);
    assert.match(text, /⟦2 selected objects⟧/);
    assert.match(text, /⟦Isolated objects \(others hidden\)⟧/);
    assert.match(text, /⟦Comments \(0\)⟧/);

    const zoomButton = ui.querySelector('[aria-label]');
    assert.ok(zoomButton);
    const ariaLabels = [...ui.querySelectorAll('[aria-label]')].map((el) => el.getAttribute('aria-label'));
    assert.ok(ariaLabels.includes(marked(CATALOGUE['bcf.topicDetail.zoomToTopicAria'] as string)));
    assert.ok(ariaLabels.includes(marked(CATALOGUE['bcf.topicDetail.deleteTopicAria'] as string)));
  });

  it('pluralizes the comment-count button and toggles the comment placeholder per selected viewpoint', () => {
    assert.ok(bcfEn, 'bcf.en.ts catalogue must exist');
    const topic = baseTopic({
      viewpoints: [
        { guid: 'vp-1', snapshot: undefined } as unknown as BCFTopic['viewpoints'][number],
      ],
      comments: [
        { guid: 'c-1', comment: 'hi', viewpointGuid: 'vp-1' } as unknown as BCFTopic['comments'][number],
      ],
    });
    const ui = render(
      <BCFTopicDetail
        topic={topic}
        onBack={noop}
        onEditTopic={noop}
        onAddComment={noop}
        onAddViewpoint={noop}
        onAddSectionViewpoint={noop}
        sectionViewpointBlockReason={null}
        onActivateViewpoint={noop}
        onDeleteViewpoint={noop}
        onUpdateStatus={noop}
        onZoomToTopic={noop}
        canZoomToTopic={false}
        onDeleteTopic={noop}
        selectionCount={0}
        hasIsolation={false}
        hasHiddenEntities={false}
      />,
    );
    registerLocale('bcf-topic-detail-plural-pseudo', {
      'bcf.topicDetail.commentCount': { one: marked('{count} comment'), other: marked('{count} comments') },
    });
    act(() => setLocale('bcf-topic-detail-plural-pseudo'));
    assert.match(ui.textContent ?? '', /⟦1 comment⟧/);
  });
});
