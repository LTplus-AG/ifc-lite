/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { act } from 'react';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { activate, cleanup, click, render } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { getLocale, registerLocale, setLocale } from '@/i18n';
import { commandPaletteDe } from '@/i18n/locales/de/command-palette';
import { commandPaletteRu } from '@/i18n/locales/ru/command-palette';
import { paletteSurfaceCommands } from './surface-commands';
import { searchCommands } from './commandPaletteSearch';
import { RegisteredPaletteOption } from './command-palette-option';
import { ThemeSwitch } from './ThemeSwitch';

const initial = useViewerStore.getState();
const locale = getLocale();
const savedTheme = localStorage.getItem('ifc-lite-theme');
afterEach(() => {
  cleanup();
  useViewerStore.setState(initial, true);
  document.documentElement.classList.remove('dark', 'colorful');
  document.documentElement.classList.add(initial.theme);
  if (savedTheme === null) localStorage.removeItem('ifc-lite-theme');
  else localStorage.setItem('ifc-lite-theme', savedTheme);
  setLocale(locale);
});
function rows() { return paletteSurfaceCommands({ canEditInSession: true }, () => {}); }
function colorful() {
  const row = rows().find(c => c.id === 'pref:colorful');
  assert.ok(row);
  return row;
}
it('palette colorful action and mounted shift-click share the same theme transition (#8947)', () => {
  useViewerStore.setState({ theme: 'dark' });
  const ui = render(<ThemeSwitch />);
  assert.equal(colorful().stateKey, 'commandPalette.state.off');
  act(() => colorful().action());
  assert.equal(ui.querySelector('button')?.getAttribute('data-theme-switch'), 'colorful');
  assert.equal(colorful().stateKey, 'commandPalette.state.on');
  assert.equal(localStorage.getItem('ifc-lite-theme'), 'colorful');
  click(ui.querySelector('button')!, { shiftKey: true });
  assert.equal(useViewerStore.getState().theme, 'light');
  assert.equal(colorful().stateKey, 'commandPalette.state.off');
  act(() => colorful().action());
  act(() => colorful().action());
  assert.equal(useViewerStore.getState().theme, 'light', 'palette exit matches the existing colorful toggle');
});
for (const [locale, catalogue, label, alias, inlineAlias] of [
  ['en', {}, 'Colorful theme', 'rainbow', 'recent queries'],
  ['de', commandPaletteDe, 'Buntes Design', 'Regenbogen', 'letzte Suchanfragen'],
  ['ru', commandPaletteRu, 'Красочная тема', 'радужная', 'недавние запросы'],
] as const) it(`registry labels and aliases reach both new routes in ${locale} (#8947)`, () => {
  if (locale !== 'en') registerLocale(locale, catalogue);
  setLocale(locale);
  const ui = render(<RegisteredPaletteOption commandId="pref:colorful" id="colorful" index={0} selected={false} onActivate={() => colorful().action()} onHover={() => {}} />);
  assert.ok(ui.textContent?.includes(label));
  act(() => useViewerStore.setState({ theme: 'light' }));
  activate(ui.querySelector('button')!, ' ');
  assert.equal(useViewerStore.getState().theme, 'colorful');
  assert.ok(searchCommands(rows(), alias, []).some(row => row.id === 'pref:colorful'));
  assert.ok(searchCommands(rows(), inlineAlias, []).some(row => row.id === 'search:inline'));
});
