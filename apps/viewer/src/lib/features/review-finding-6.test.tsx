/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, click, render } from '@/test/render';
import { useViewerStore } from '@/store';
import { resetFeaturesForTest } from './index';
import { WelcomeFooterChips } from '@/components/viewer/WelcomeFooterChips';
import { getTour } from '@/lib/tours/registry';

const initial = useViewerStore.getState();
const tourStorage = window.localStorage.getItem('ifc-lite:tours:v1');
afterEach(() => {
  cleanup();
  resetFeaturesForTest();
  useViewerStore.setState(initial, true);
  if (tourStorage === null) window.localStorage.removeItem('ifc-lite:tours:v1');
  else window.localStorage.setItem('ifc-lite:tours:v1', tourStorage);
});
it('hides the tour-only prompt on mobile, after completion and after dismissal (#10176)', () => {
  resetFeaturesForTest({ default: 'all', disable: ['help.product-links'] });
  const footer = () => render(<WelcomeFooterChips tourAvailable />);
  window.localStorage.removeItem('ifc-lite:tours:v1');
  useViewerStore.setState({ isMobile: true });
  assert.doesNotMatch(footer().textContent ?? '', /New here/);
  cleanup();
  useViewerStore.setState({ isMobile: false });
  const welcome = getTour('welcome');
  assert.ok(welcome);
  window.localStorage.setItem('ifc-lite:tours:v1', JSON.stringify({ tours: { welcome: { completedVersion: welcome.version, completedAt: 'now' } } }));
  assert.doesNotMatch(footer().textContent ?? '', /New here/);
  cleanup();
  window.localStorage.removeItem('ifc-lite:tours:v1');
  const shown = footer();
  assert.match(shown.textContent ?? '', /New here/);
  const dismiss = shown.querySelector<HTMLButtonElement>('button[aria-label]');
  assert.ok(dismiss);
  click(dismiss);
  assert.doesNotMatch(shown.textContent ?? '', /New here/);
  cleanup();
  assert.doesNotMatch(footer().textContent ?? '', /New here/);
});
