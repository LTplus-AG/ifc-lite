/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, click, render, type } from '@/test/render.js';
import { registerLocale, setLocale, type Catalogue } from '@/i18n';
import { useViewerStore } from '@/store';
import { getDefaultSectionPlane } from '@/store/slices/sectionSlice.js';
import { ViewportHud } from '../../viewport-ui/hud/ViewportHud.js';
import { ToolOverlays } from '../ToolOverlays.js';
import { SceneOverlayRoot } from '@/components/viewport-ui/scene';

const CAP_LOCALE: Catalogue = {
  'sectionTool.cap.label': 'Surface locale',
  'sectionCap.display': 'Affichage',
  'sectionCap.surfaces': 'Faces',
  'sectionCap.lines': 'Traits',
  'sectionCap.hideSurfaces': 'Masquer toutes les faces',
  'sectionCap.showSurfaces': 'Afficher toutes les faces',
  'sectionCap.hideLines': 'Masquer tous les traits',
  'sectionCap.showLines': 'Afficher tous les traits',
  'sectionCap.patternLabel': 'Motif local',
  'sectionCap.pattern.solid': 'Plein local',
  'sectionCap.pattern.diagonal': 'Diagonale locale',
  'sectionCap.pattern.crossHatch': 'Croisé local',
  'sectionCap.pattern.horizontal': 'Horizontal local',
  'sectionCap.pattern.vertical': 'Vertical local',
  'sectionCap.pattern.concrete': 'Béton local',
  'sectionCap.pattern.brick': 'Brique locale',
  'sectionCap.pattern.insulation': 'Isolant local',
  'sectionCap.fillLabel': 'Fond',
  'sectionCap.hatchLabel': 'Hachure',
  'sectionCap.fillAriaLabel': 'Couleur du fond',
  'sectionCap.hatchAriaLabel': 'Couleur des hachures',
  'sectionCap.spacingLabel': 'Espacement local',
  'sectionCap.angleLabel': 'Angle local',
  'sectionCap.widthLabel': 'Largeur locale',
};

/** Mount the Section tool through its production host and open the bar's Cap popover (#5499). */
function mountedCap(capLabel = 'Cap'): HTMLElement {
  render(<><ViewportHud /><SceneOverlayRoot><ToolOverlays /></SceneOverlayRoot></>);
  const bar = document.querySelector<HTMLElement>('[data-tool-bar="section"]');
  assert.ok(bar, 'the Section bar is mounted');
  const trigger = [...bar.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim() === capLabel);
  assert.ok(trigger, `Cap trigger "${capLabel}"`);
  click(trigger);
  const cap = document.querySelector<HTMLElement>('[data-section-cap-controls]');
  assert.ok(cap, 'the Cap popover opened');
  return cap;
}

function toggle(ui: HTMLElement, text: string): HTMLButtonElement {
  const found = [...ui.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim() === text);
  assert.ok(found, `toggle ${text}`);
  return found;
}

function labelledControl<T extends HTMLElement>(ui: HTMLElement, label: string): T {
  const labelElement = [...ui.querySelectorAll('label')].find((candidate) => candidate.textContent?.trim() === label);
  assert.ok(labelElement, `label ${label}`);
  const id = labelElement.htmlFor;
  const control = ui.querySelector<T>(`#${CSS.escape(id)}`);
  assert.ok(control, `control ${label}`);
  return control;
}

beforeEach(() => {
  window.localStorage.clear();
  window.localStorage.setItem('ifc-lite:section-last-mode', JSON.stringify({ kind: 'cardinal', axis: 'down', position: 50, flipped: false }));
  setLocale('en');
  useViewerStore.setState({ activeTool: 'section', sectionPlane: getDefaultSectionPlane(), sectionPickMode: false, sectionPickPreview: null });
});

afterEach(() => {
  cleanup();
  setLocale('en');
  window.localStorage.clear();
});

describe('mounted Section cap localization (#4785)', () => {
  it('keeps English options, IDs and independent complete display titles', () => {
    const ui = mountedCap();
    assert.match(ui.textContent ?? '', /Display/);
    const select = labelledControl<HTMLSelectElement>(ui, 'Hatch pattern');
    assert.deepEqual([...select.options].map((option) => [option.value, option.textContent]), [
      ['diagonal', 'Diagonal'], ['crossHatch', 'Cross-hatch'], ['horizontal', 'Horizontal'],
      ['vertical', 'Vertical'], ['concrete', 'Concrete'], ['brick', 'Brick'],
      ['insulation', 'Insulation'], ['solid', 'Solid fill'],
    ]);
    const surfaces = toggle(ui, 'Surfaces');
    const lines = toggle(ui, 'Lines');
    assert.equal(surfaces.title, 'Hide surfaces');
    assert.equal(lines.title, 'Hide lines');
    assert.equal(surfaces.getAttribute('aria-pressed'), 'true');
    click(surfaces);
    assert.equal(toggle(ui, 'Surfaces').title, 'Show surfaces');
    assert.equal(toggle(ui, 'Surfaces').getAttribute('aria-pressed'), 'false');
    assert.equal(useViewerStore.getState().sectionPlane.showOutlines, true);
    assert.equal(ui.querySelector('fieldset')?.hasAttribute('disabled'), true);
    click(lines);
    assert.equal(toggle(ui, 'Lines').title, 'Show lines');
    assert.equal(useViewerStore.getState().sectionPlane.showCap, false);
  });

  it('renders every translated option and complete tooltip through the production host', () => {
    registerLocale('cap-test', CAP_LOCALE);
    setLocale('cap-test');
    const ui = mountedCap('Surface locale');
    assert.match(ui.textContent ?? '', /Affichage/);
    assert.equal(toggle(ui, 'Faces').title, 'Masquer toutes les faces');
    assert.equal(toggle(ui, 'Traits').title, 'Masquer tous les traits');
    const select = labelledControl<HTMLSelectElement>(ui, 'Motif local');
    assert.deepEqual([...select.options].map((option) => option.textContent), [
      'Diagonale locale', 'Croisé local', 'Horizontal local', 'Vertical local',
      'Béton local', 'Brique locale', 'Isolant local', 'Plein local',
    ]);
    act(() => {
      select.value = 'brick';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    assert.equal(useViewerStore.getState().sectionPlane.capStyle.pattern, 'brick');
    click(toggle(ui, 'Faces'));
    assert.equal(toggle(ui, 'Faces').title, 'Afficher toutes les faces');
  });

  it('edits translated cap fields without changing IDs, alpha or angle semantics', () => {
    registerLocale('cap-test', CAP_LOCALE);
    setLocale('cap-test');
    const ui = mountedCap('Surface locale');
    const fill = ui.querySelector<HTMLInputElement>('input[aria-label="Couleur du fond"]');
    const hatch = ui.querySelector<HTMLInputElement>('input[aria-label="Couleur des hachures"]');
    assert.ok(fill && hatch);
    act(() => useViewerStore.getState().setSectionCapStyle({
      fillColor: [0.1, 0.2, 0.3, 0.35], strokeColor: [0.4, 0.5, 0.6, 0.65],
    }));
    type(fill, '#ff0000');
    type(hatch, '#00ff00');
    type(labelledControl<HTMLInputElement>(ui, 'Espacement local'), '19');
    type(labelledControl<HTMLInputElement>(ui, 'Angle local'), '-45');
    type(labelledControl<HTMLInputElement>(ui, 'Largeur locale'), '3.5');
    const style = useViewerStore.getState().sectionPlane.capStyle;
    assert.deepEqual(style.fillColor, [1, 0, 0, 0.35]);
    assert.deepEqual(style.strokeColor, [0, 1, 0, 0.65]);
    assert.equal(style.spacingPx, 19);
    assert.ok(Math.abs(style.angleRad + Math.PI / 4) < 1e-12);
    assert.equal(style.widthPx, 3.5);
  });

  it('falls back per missing cap key and updates an active catalogue in place', () => {
    registerLocale('partial-cap', { 'sectionCap.display': 'Localized display', 'sectionCap.hideSurfaces': 'Localized hide' });
    setLocale('partial-cap');
    const ui = mountedCap();
    assert.match(ui.textContent ?? '', /Localized display/);
    assert.equal(toggle(ui, 'Surfaces').title, 'Localized hide');
    assert.equal(toggle(ui, 'Lines').title, 'Hide lines');
    assert.ok([...labelledControl<HTMLSelectElement>(ui, 'Hatch pattern').options].some((option) => option.textContent === 'Brick'));
    act(() => registerLocale('partial-cap', { 'sectionCap.display': 'Replacement display', 'sectionCap.hideSurfaces': 'Replacement hide' }));
    assert.match(ui.textContent ?? '', /Replacement display/);
    assert.equal(toggle(ui, 'Surfaces').title, 'Replacement hide');
  });
});
