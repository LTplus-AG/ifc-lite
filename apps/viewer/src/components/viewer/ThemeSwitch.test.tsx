/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #8802 R1 review: the theme toggle's icon is hidden from assistive tech, so
 * its accessible name and tooltip must name the theme a click switches TO.
 */
import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, click, render } from '@/test/render';
import { resolve } from '@/i18n/registry';
import { useViewerStore } from '@/store';
import { ThemeSwitch } from './ThemeSwitch';

afterEach(() => {
  cleanup();
  useViewerStore.setState({ theme: 'dark' });
});

function themeButton(container: HTMLElement): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>('button[data-theme-switch]');
  assert.ok(button, 'the theme switch rendered');
  return button;
}

function description(button: HTMLElement): string {
  return document.getElementById(button.getAttribute('aria-describedby') ?? '')?.textContent ?? '';
}

it('names the destination theme in its label and description, and follows a click', () => {
  useViewerStore.setState({ theme: 'dark' });
  const button = themeButton(render(<ThemeSwitch />));
  assert.equal(button.getAttribute('aria-label'), resolve('ribbon.themeSwitchToLight'));
  assert.equal(description(button), resolve('ribbon.themeSwitchToLightTooltip'));

  click(button);
  assert.equal(useViewerStore.getState().theme, 'light');
  assert.equal(button.getAttribute('aria-label'), resolve('ribbon.themeSwitchToDark'));
  assert.equal(description(button), resolve('ribbon.themeSwitchToDarkTooltip'));
});

it('offers dark from the colorful theme, where a plain click lands', () => {
  useViewerStore.setState({ theme: 'colorful' });
  const button = themeButton(render(<ThemeSwitch />));
  assert.equal(button.getAttribute('aria-label'), resolve('ribbon.themeSwitchToDark'));
  click(button);
  assert.equal(useViewerStore.getState().theme, 'dark');
});
