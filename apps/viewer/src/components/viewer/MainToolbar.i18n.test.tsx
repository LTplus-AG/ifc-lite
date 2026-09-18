/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The classic `MainToolbar`'s own chrome reads the i18n catalogue (#4918
 * slice 1, following #4785/#4883).
 *
 * The oracle is a pseudo-locale that maps every `mainToolbar.*` key to a
 * marked copy of its English text. The strip is rendered in a state that
 * surfaces as much of its own chrome as possible (a model loaded, a
 * selection, edit mode and the Cesium overlay on), the locale is switched
 * live, and every marked string that was readable in English must reappear
 * marked. A label left hardcoded, or a consumer that does not re-render on
 * a locale switch, fails here by name.
 *
 * Two DOM surfaces need separate handling, in two passes:
 *  - CHROME: aria-labels are always in the tree; Radix `TooltipContent`
 *    only mounts once its trigger is focused. Focusing every button opens
 *    each one in turn (Radix opens a tooltip synchronously on focus).
 *  - MENUS: `DropdownMenuContent` only mounts once its trigger opens the
 *    menu, and Radix's dropdown is modal — once one is open, focusing an
 *    element outside it gets redirected back in by its focus trap, which
 *    would silently break the CHROME pass. So menus are opened in a
 *    separate render with no focus-walk, reading their (non-tooltip) text
 *    directly off the DOM instead.
 *
 * Deliberately excludes the shared command surfaces MainToolbar hosts but
 * does not own — `ClassicExportMenuItems`, `BottomPanelMenuItems`,
 * `AuthorPanelMenuItems`, `CameraCommandMenuItems`, `ClassVisibilityMenuContent`
 * — those are catalogued by #4918 slice 2, not this file.
 */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, render } from '@/test/render.js';
import { registerLocale, setLocale, type Catalogue } from '@/i18n';
import { mainToolbarEn } from '@/i18n/catalogues/main-toolbar.en';
import { useViewerStore } from '@/store';
import type { FederatedModel } from '@/store/types';
import { MainToolbar } from './MainToolbar.js';

type MainToolbarKey = keyof typeof mainToolbarEn;
const KEYS = Object.keys(mainToolbarEn) as MainToolbarKey[];
const STATIC_KEYS = KEYS.filter((key) => !mainToolbarEn[key].includes('{'));

function makeModel(): FederatedModel {
  return {
    id: 'm1',
    name: 'm1.ifc',
    ifcDataStore: null,
    geometryResult: null,
    visible: true,
    collapsed: false,
    schemaVersion: 'IFC4',
    loadedAt: 1,
    fileSize: 3,
    idOffset: 0,
    maxExpressId: 0,
  };
}

const STATE = {
  models: new Map([['m1', makeModel()]]),
  selectedEntityId: 11,
  selectedEntityIds: new Set([11, 12, 13]),
  editEnabled: true,
  collabRole: null,
  cesiumAvailable: true,
  cesiumEnabled: true,
  cesiumPlacementEditMode: false,
  basketPresentationVisible: false,
  envPanelOpen: false,
  spaceMousePanelOpen: false,
  mergeLayers: false,
} as Partial<ReturnType<typeof useViewerStore.getState>>;

const RESET = {
  models: new Map(),
  selectedEntityId: null,
  selectedEntityIds: new Set(),
  editEnabled: false,
  cesiumAvailable: false,
  cesiumEnabled: false,
  basketPresentationVisible: false,
} as Partial<ReturnType<typeof useViewerStore.getState>>;

/** Dispatch the pointerdown+click pair Radix's uncontrolled DropdownMenu
 *  trigger needs to open — a plain `click` does not toggle it (#4918). */
function openMenu(trigger: Element): void {
  act(() => {
    trigger.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
  });
  act(() => {
    trigger.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

function addReadable(root: ParentNode, out: Set<string>): void {
  root.querySelectorAll('*').forEach((element) => {
    const label = element.getAttribute('aria-label');
    if (label) out.add(label);
    const ownText = [...element.childNodes]
      .filter((node) => node.nodeType === node.TEXT_NODE)
      .map((node) => node.textContent ?? '')
      .join('')
      .trim();
    if (ownText) out.add(ownText);
  });
}

/** aria-labels, plain text, and (by focusing each button in turn) every
 *  reachable Radix `TooltipContent` string. Menus must be closed — an open
 *  modal DropdownMenu redirects focus back into itself. */
function chromeStrings(container: HTMLElement): Set<string> {
  const out = new Set<string>();
  addReadable(document.body, out);
  for (const button of container.querySelectorAll('button')) {
    act(() => button.focus());
    addReadable(document.body, out);
    act(() => button.blur());
  }
  return out;
}

/** Key-specific pseudo translation; keeps every `{placeholder}` of the English text. */
const mark = (key: MainToolbarKey) => `⟦${key}|${mainToolbarEn[key]}⟧`;
const PSEUDO: Catalogue = Object.fromEntries(KEYS.map((key) => [key, mark(key)]));

/**
 * Static keys this render cannot show, each for a stated reason — either a
 * mutually-exclusive UI state this render did not pick, or a control this
 * render did not set up (no disk-backed model handle for Refresh, no
 * analysis extensions installed, the collab flag off). Interpolated keys
 * (`{count}`, `{views}`, `{label}`, …) are exercised by
 * `MainToolbar.locale.i18n.test.tsx` instead — a pseudo-marked template
 * with a literal `{` in it is not the assertion this oracle makes.
 */
const NOT_RENDERED_IN_THIS_STATE: MainToolbarKey[] = [
  'mainToolbar.refreshModel', // no disk-backed model handle in this render (canRefresh stays false)
  'mainToolbar.refreshModels',
  'mainToolbar.editPropertiesTooltip', // Edit properties is disabled (no ifcDataStore); a disabled trigger cannot be focused
  'mainToolbar.bulkPropertyEditor', // inside the Edit properties menu, which stays closed (disabled trigger)
  'mainToolbar.importDataCsv',
  'mainToolbar.share', // collab feature flag is off under test
  'mainToolbar.room',
  'mainToolbar.collaborationRoom', // Panels menu item gated on the same flag
  'mainToolbar.analysisExtensions', // no analysis extensions installed
  'mainToolbar.editModeEnterAriaLabel', // edit mode is on in this render
  'mainToolbar.editModeEnterTooltip',
  'mainToolbar.editModeLocked', // single-user session can always edit
  'mainToolbar.presentationHide', // presentation dock is hidden in this render
  'mainToolbar.visibilityMerged', // Merge Multilayer Walls is off in this render
  'mainToolbar.visibilityMergedTooltip',
  'mainToolbar.cesiumShow', // Cesium is enabled in this render
  'mainToolbar.moveGeorefStop', // not in placement mode
  'mainToolbar.sunSkyClose', // Sun & Sky panel is closed in this render
  'mainToolbar.spaceMouseClose', // SpaceMouse panel is closed in this render
];

beforeEach(() => {
  setLocale('en');
  useViewerStore.setState(STATE);
});

afterEach(() => {
  cleanup();
  setLocale('en');
  useViewerStore.setState(RESET);
});

describe('MainToolbar localization (#4918)', () => {
  it('translates the always-visible chrome: aria-labels and tooltips', () => {
    const container = render(<MainToolbar />);
    const english = chromeStrings(container);

    registerLocale('main-toolbar-chrome-pseudo', PSEUDO);
    act(() => setLocale('main-toolbar-chrome-pseudo'));
    const after = chromeStrings(container);

    const covered = new Set<MainToolbarKey>();
    for (const key of STATIC_KEYS) {
      const text = mainToolbarEn[key];
      if (!english.has(text)) continue; // not chrome text in this render; checked elsewhere
      assert.ok(after.has(mark(key)), `${key}: "${text}" must be translated, marked text not found`);
      covered.add(key);
    }
    // Everything covered here must be excluded from the not-rendered list,
    // and nothing double-counts the menu pass below.
    for (const key of covered) {
      assert.ok(!NOT_RENDERED_IN_THIS_STATE.includes(key), `${key}: covered by chrome, drop it from NOT_RENDERED_IN_THIS_STATE`);
    }
  });

  it('translates the Panels and View options menu bodies it owns', () => {
    const container = render(<MainToolbar />);
    const triggers = () => [...container.querySelectorAll('button[aria-haspopup="menu"]')];
    const panelsTrigger = () => triggers().find((t) => t.getAttribute('aria-label')?.startsWith('Panels'));
    const viewOptionsTrigger = () => triggers().find((t) => t.getAttribute('aria-label') === 'View options');

    openMenu(panelsTrigger()!);
    openMenu(viewOptionsTrigger()!);
    const english = new Set<string>();
    addReadable(document.body, english);

    registerLocale('main-toolbar-menu-pseudo', PSEUDO);
    act(() => setLocale('main-toolbar-menu-pseudo'));
    const after = new Set<string>();
    addReadable(document.body, after);

    for (const key of STATIC_KEYS) {
      const text = mainToolbarEn[key];
      if (!english.has(text)) continue;
      assert.ok(after.has(mark(key)), `${key}: "${text}" must be translated, marked text not found`);
    }
  });

  it('accounts for every static key across both passes or a documented reason', () => {
    const container = render(<MainToolbar />);
    const chromeEnglish = chromeStrings(container);

    const triggers = () => [...container.querySelectorAll('button[aria-haspopup="menu"]')];
    openMenu(triggers().find((t) => t.getAttribute('aria-label')?.startsWith('Panels'))!);
    openMenu(triggers().find((t) => t.getAttribute('aria-label') === 'View options')!);
    const menuEnglish = new Set<string>();
    addReadable(document.body, menuEnglish);

    const seenAnywhere = STATIC_KEYS.filter(
      (key) => chromeEnglish.has(mainToolbarEn[key]) || menuEnglish.has(mainToolbarEn[key]),
    );
    const unaccounted = STATIC_KEYS.filter(
      (key) => !seenAnywhere.includes(key) && !NOT_RENDERED_IN_THIS_STATE.includes(key),
    );
    assert.deepEqual(unaccounted, [], 'key neither rendered nor listed in NOT_RENDERED_IN_THIS_STATE');

    const staleExclusions = NOT_RENDERED_IN_THIS_STATE.filter((key) => seenAnywhere.includes(key));
    assert.deepEqual(staleExclusions, [], 'key listed as not-rendered but is actually on screen in this render');
  });
});
