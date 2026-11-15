/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, render } from '@/test/render';
import { useViewerStore } from '@/store';
import { resetFeaturesForTest } from './index';
import { ReviewCard } from '@/components/viewer/review/ReviewCard';
import type { CoordinationCard } from '@/lib/review/cards';

const initial = useViewerStore.getState();
const tourStorage = window.localStorage.getItem('ifc-lite:tours:v1');
afterEach(() => {
  cleanup();
  resetFeaturesForTest();
  useViewerStore.setState(initial, true);
  if (tourStorage === null) window.localStorage.removeItem('ifc-lite:tours:v1');
  else window.localStorage.setItem('ifc-lite:tours:v1', tourStorage);
});
it('hides the review Ask action when the assistant is off (#10176)', () => {
  const card: CoordinationCard = { key: 'test', identity: 'unvalidated', elements: [], findings: [], sources: [],
    state: 'current', topics: [], related: [], disciplines: [], storeys: [], models: [] };
  const review = () => render(<ReviewCard card={card} titles={new Map()} decision={null} expanded selected={false}
    onToggle={() => {}} onSelect={() => {}} onOpenRelated={() => {}} onDraft={() => {}} />);
  const ask = (root: HTMLElement) => [...root.querySelectorAll('button')].find(b => b.textContent === 'Ask about this card');
  assert.ok(ask(review()));
  cleanup();
  resetFeaturesForTest({ default: 'all', disable: ['ai.assistant'] });
  assert.ok(!ask(review()));
});