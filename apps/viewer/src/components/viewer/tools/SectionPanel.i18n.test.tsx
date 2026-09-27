/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The mounted Section tool's localization (#4785), through the production
 * host (`ToolOverlays` + the HUD): the bar (#5499), the hint line (#5500)
 * and the face-pick timing all render whole translated messages, fall back per
 * missing key, and re-render an active catalogue in place without losing
 * store state or restarting the tool's timers.
 */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { advance, cleanup, click, press, render, type } from '@/test/render.js';
import { registerLocale, setLocale, type Catalogue } from '@/i18n';
import { useViewerStore } from '@/store';
import { getDefaultSectionPlane } from '@/store/slices/sectionSlice.js';
import { ViewportHud } from '../../viewport-ui/hud/ViewportHud.js';
import { ToolOverlays } from '../ToolOverlays.js';
import { SceneOverlayRoot } from '@/components/viewport-ui/scene';
import { SectionParkedChip } from './SectionParkedChip.js';

const TEST_LOCALE: Catalogue = {
  'sectionTool.heading': 'Coupe',
  'sectionTool.closeTitle': 'Fermer',
  'sectionTool.bar.axisAria': 'Axe de coupe',
  'sectionTool.axis.down': 'Bas',
  'sectionTool.axis.front': 'Avant',
  'sectionTool.axis.side': 'Côté',
  'sectionTool.axis.face': 'Face locale',
  'sectionTool.pick.activeTitle': 'Cliquez une face dans la vue',
  'sectionTool.pick.title': 'Choisir une face',
  'sectionTool.flipLabel': 'Inverser la coupe',
  'sectionTool.unflipLabel': 'Rétablir la coupe',
  'sectionTool.flippedTitle': 'Direction inversée',
  'sectionTool.distance.aria': 'Distance locale',
  'sectionTool.distance.customAria': 'Distance du plan local',
  'sectionTool.distance.unit': ' mètres',
  'sectionTool.distance.percentUnit': ' pour cent',
  'sectionTool.cap.label': 'Surface',
  'sectionTool.cap.title': 'Surface de coupe',
  'sectionTool.cut.label': 'Couper',
  'sectionTool.cut.onTitle': 'Désactiver la coupe',
  'sectionTool.cut.offTitle': 'Activer la coupe',
  'sectionTool.drawing.label': 'Plan',
  'sectionTool.drawing.openTitle': 'Ouvrir le dessin en panneau',
  'sectionTool.drawing.closeTitle': 'Fermer le dessin',
  'sectionTool.hint.pick': 'Survolez puis cliquez',
  'sectionTool.hint.cut': 'Glissez la distance pour déplacer la coupe',
  'sectionTool.hint.off': 'Coupe inactive',
  'sectionTool.parked.label': '{distance} m — {axis}',
  'sectionTool.parked.labelPercent': '{position} % — {axis}',
  'sectionTool.parked.faceAxis': 'Face locale',
  'sectionTool.parked.resumeAria': 'Reprendre la coupe',
  'sectionTool.parked.resumeTitle': 'Rouvrir l\'outil',
  'sectionTool.parked.clearAria': 'Oublier la coupe',
  'sectionTool.parked.clearTitle': 'Oublier',
};

const bar = () => document.querySelector<HTMLElement>('[data-tool-bar="section"]')!;

function button(text: string): HTMLButtonElement {
  const result = [...bar().querySelectorAll('button')].find((candidate) =>
    candidate.textContent?.trim() === text || candidate.title === text || candidate.getAttribute('aria-label') === text);
  assert.ok(result, `button ${text}`);
  return result;
}

function field(): HTMLElement {
  const el = bar().querySelector<HTMLElement>('[role="spinbutton"]');
  assert.ok(el, 'distance field');
  return el;
}

function hint(): string {
  return document.querySelector('[data-hud-region="bottom-center"]')?.textContent?.trim() ?? '';
}
function chip(): string {
  return document.querySelector('[data-hud-region="top-left"]')?.textContent?.trim() ?? '';
}

beforeEach(() => {
  window.localStorage.clear();
  setLocale('en');
  useViewerStore.setState({
    activeTool: 'section',
    sectionPlane: getDefaultSectionPlane(),
    sectionPickMode: false,
    sectionPickPreview: null,
    models: new Map(),
    geometryResult: null,
    ifcDataStore: null,
    pointCloudAssetCount: 1,
    pointCloudPreviewStride: 1,
    drawing2DPanelVisible: false,
    drawing2D: null,
  });
});

afterEach(() => {
  cleanup();
  setLocale('en');
  window.localStorage.clear();
});

const renderTool = () => render(<><ViewportHud /><SectionParkedChip /><SceneOverlayRoot><ToolOverlays /></SceneOverlayRoot></>);

describe('mounted Section tool localization (#4785)', () => {
  it('preserves default English controls, cardinal states and clipping behavior', () => {
    window.localStorage.setItem('ifc-lite:section-last-mode', JSON.stringify({ kind: 'cardinal', axis: 'down', position: 50, flipped: false }));
    const ui = renderTool();
    assert.match(bar().textContent ?? '', /Section/);
    assert.equal(button('Close').title, 'Close');
    assert.equal(button('Face').title, 'Pick a face to cut through');
    assert.equal(field().getAttribute('aria-label'), 'Cut distance along the axis');

    assert.equal(hint(), 'Drag the distance to move the cut · Esc to finish');
    click(button('Flip cut direction'));
    assert.equal(button('Unflip cut direction').title, 'Cut direction is flipped');
    click(button('Unflip cut direction'));

    const cut = button('Cut');
    assert.equal(cut.title, 'Clipping the model — click to preview the plane without cutting');
    click(cut);
    assert.equal(button('Cut').title, 'Not clipping — click to cut the model');
    assert.equal(hint(), 'Cut is off · turn on Cut to clip the model');
    assert.equal(ui.querySelector('[data-section-hint]'), null, 'the black hint strip is gone (#5500)');
    assert.equal(ui.querySelector('[data-section-badge]'), null, 'the corner badge is gone (#5500)');
  });

  it('renders whole reordered messages for translated cardinal and signed custom state', () => {
    registerLocale('section-test', TEST_LOCALE);
    window.localStorage.setItem('ifc-lite:section-last-mode', JSON.stringify({ kind: 'cardinal', axis: 'front', position: 50, flipped: false }));
    setLocale('section-test');
    renderTool();
    assert.match(bar().textContent ?? '', /Coupe/);
    assert.equal(bar().querySelector('[role="radiogroup"]')?.getAttribute('aria-label'), 'Axe de coupe');
    assert.equal(field().getAttribute('aria-valuetext'), '50.00 pour cent', 'no bounds: the percentage carries the translated unit');
    act(() => useViewerStore.getState().setSectionPlanePosition(37.5));
    assert.equal(hint(), 'Glissez la distance pour déplacer la coupe');
    click(button('Inverser la coupe'));
    assert.equal(button('Rétablir la coupe').title, 'Direction inversée');

    act(() => useViewerStore.getState().setSectionPlaneFromFace([1, 0, 0], [-2.345, 0, 0]));
    assert.equal(button('Face locale').getAttribute('aria-checked'), 'true');
    assert.equal(field().getAttribute('aria-label'), 'Distance du plan local');
    assert.equal(field().getAttribute('aria-valuetext'), '-2.35 mètres');
    press(field(), 'Enter');
    const input = bar().querySelector<HTMLInputElement>('input[aria-label="Distance du plan local"]');
    assert.ok(input);
    type(input, '-1.125');
    press(input, 'Enter');
    assert.equal(useViewerStore.getState().sectionPlane.custom?.distance, -1.125);

    // Leave the tool: the parked chip renders the whole reordered message.
    act(() => useViewerStore.getState().setActiveTool('select'));
    assert.equal(chip(), '-1.13 m — Face locale');
    assert.equal(document.querySelector('button[aria-label="Reprendre la coupe"]')?.getAttribute('title'), "Rouvrir l'outil");
    click(document.querySelector('button[aria-label="Reprendre la coupe"]')!);
    assert.equal(useViewerStore.getState().activeTool, 'section');
    click(button('Côté'));
    assert.equal(useViewerStore.getState().sectionPlane.custom, undefined);
    act(() => useViewerStore.getState().setActiveTool('select'));
    assert.equal(chip(), '37.5 % — Côté', 'no bounds: the percentage form, reordered');
  });

  it('uses exact fallback and restores English for an unknown locale', () => {
    registerLocale('partial-section', {
      'sectionTool.heading': 'Localized section',
      'sectionTool.cut.label': '',
    });
    window.localStorage.setItem('ifc-lite:section-last-mode', JSON.stringify({ kind: 'cardinal', axis: 'front', position: 42.25, flipped: false }));
    setLocale('partial-section');
    renderTool();
    assert.match(bar().textContent ?? '', /Localized section/);
    assert.equal(hint(), 'Drag the distance to move the cut · Esc to finish');
    assert.equal(button('Face').title, 'Pick a face to cut through');
    const blankCut = button('Clipping the model — click to preview the plane without cutting');
    assert.equal(blankCut.textContent?.trim(), '', 'an explicit blank label stays blank, not English');
    const plane = useViewerStore.getState().sectionPlane;
    act(() => setLocale('missing-locale'));
    assert.match(bar().textContent ?? '', /Section/);
    assert.equal(useViewerStore.getState().sectionPlane, plane);
  });

  it('updates a mounted active catalogue without remounting or losing state', () => {
    registerLocale('live-section', TEST_LOCALE);
    window.localStorage.setItem('ifc-lite:section-last-mode', JSON.stringify({ kind: 'cardinal', axis: 'side', position: 22, flipped: false }));
    renderTool();
    act(() => useViewerStore.getState().setSectionPlanePosition(37.5));
    click(button('Flip cut direction'));
    act(() => useViewerStore.getState().setSectionPlaneFromFace([1, 0, 0], [-2.5, 0, 0]));
    click(button('Flip cut direction'));
    const barNode = bar();
    const fieldNode = field();
    fieldNode.focus();
    const storedMode = window.localStorage.getItem('ifc-lite:section-last-mode');
    const planeBeforeSwitch = useViewerStore.getState().sectionPlane;

    act(() => setLocale('live-section'));
    assert.equal(bar(), barNode, 'the bar is the same DOM node');
    assert.equal(field(), fieldNode, 'the field is the same DOM node');
    assert.equal(document.activeElement, fieldNode);
    assert.equal(field().getAttribute('aria-label'), 'Distance du plan local');
    assert.equal(useViewerStore.getState().sectionPlane, planeBeforeSwitch);
    assert.equal(window.localStorage.getItem('ifc-lite:section-last-mode'), storedMode);

    act(() => registerLocale('live-section', { ...TEST_LOCALE, 'sectionTool.heading': 'Coupe remplacée', 'sectionTool.hint.cut': 'Remplacé' }));
    assert.match(bar().textContent ?? '', /Coupe remplacée/);
    assert.equal(hint(), 'Remplacé');

    act(() => setLocale('en'));
    assert.equal(field(), fieldNode);
    assert.equal(document.activeElement, fieldNode);
    assert.equal(useViewerStore.getState().sectionPlane, planeBeforeSwitch);
  });

  it('does not restart the delayed face-pick timer when the locale changes', async () => {
    registerLocale('section-test', TEST_LOCALE);
    renderTool();
    assert.equal(useViewerStore.getState().sectionPickMode, false);
    await advance(100);
    act(() => setLocale('section-test'));
    assert.match(bar().textContent ?? '', /Coupe/);
    assert.equal(useViewerStore.getState().sectionPickMode, false, 'the original delay is still pending at the locale switch');
    await advance(110);
    assert.equal(useViewerStore.getState().sectionPickMode, true, 'locale rerender did not restart the mount timer');
    act(() => {
      useViewerStore.getState().setSectionPickMode(false);
      setLocale('en');
    });
    await advance(220);
    assert.equal(useViewerStore.getState().sectionPickMode, false, 'a locale switch after disarming does not rearm pick mode');
  });

  it('translates delayed face-pick instructions and preserves drawing and close actions', async () => {
    registerLocale('section-test', TEST_LOCALE);
    setLocale('section-test');
    renderTool();
    await advance(220);
    assert.equal(hint(), 'Survolez puis cliquez');
    const face = button('Face locale');
    assert.equal(face.title, 'Cliquez une face dans la vue');
    assert.equal(face.getAttribute('aria-checked'), 'true');
    click(button('Bas'));
    assert.equal(button('Face locale').title, 'Choisir une face');

    useViewerStore.setState({ drawing2D: { marker: 'stale' } as never });
    click(button('Ouvrir le dessin en panneau'));
    assert.equal(useViewerStore.getState().drawing2DPanelVisible, true);
    assert.equal(useViewerStore.getState().drawing2D, null);
    assert.equal(button('Plan').title, 'Fermer le dessin');

    click(button('Fermer'));
    assert.equal(useViewerStore.getState().activeTool, 'select');
    assert.equal(document.querySelector('[data-tool-bar="section"]'), null);
    assert.equal(useViewerStore.getState().pointCloudPreviewStride, 1);
  });
});
