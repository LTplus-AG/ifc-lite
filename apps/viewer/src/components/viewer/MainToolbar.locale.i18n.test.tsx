/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Registered-locale behaviour of the classic `MainToolbar` (#4918 slice 1,
 * following #4785): interpolated counts and per-key English fallback.
 *
 * Deliberately imports nothing that this change added besides the
 * component and the pre-existing `@/i18n` registry, and names catalogue
 * keys as literals, so a revert of the MainToolbar conversion still loads
 * this file and fails on its assertions instead of at import.
 */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, click, render } from '@/test/render.js';
import { registerLocale, setLocale } from '@/i18n';
import { useViewerStore } from '@/store';
import type { FederatedModel } from '@/store/types';
import { MainToolbar } from './MainToolbar.js';

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

function readableStrings(root: HTMLElement): Set<string> {
  const out = new Set<string>();
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
  return out;
}

beforeEach(() => {
  setLocale('en');
});

afterEach(() => {
  cleanup();
  setLocale('en');
  useViewerStore.setState({
    models: new Map(),
    selectedEntityId: null,
    selectedEntityIds: new Set(),
    basketPresentationVisible: false,
  } as Partial<ReturnType<typeof useViewerStore.getState>>);
});

describe('MainToolbar with a registered locale (#4918)', () => {
  it('interpolates the live selection count into translated labels', () => {
    registerLocale('main-toolbar-counts', {
      'mainToolbar.selectionActionsAriaLabel': 'Auswahlaktionen — {count} ausgewählt',
      'mainToolbar.selectionCountBadge': '{count} Ausw.',
    });
    setLocale('main-toolbar-counts');
    useViewerStore.setState({
      selectedEntityId: 11,
      selectedEntityIds: new Set([11, 12, 13]),
    } as Partial<ReturnType<typeof useViewerStore.getState>>);
    const container = render(<MainToolbar />);

    assert.ok(
      container.querySelector('[role="group"][aria-label="Auswahlaktionen — 3 ausgewählt"]'),
      'selection actions group carries the interpolated count',
    );
    const strings = readableStrings(container);
    assert.ok(strings.has('3 Ausw.'), 'selection count badge carries the interpolated count');
  });

  it('interpolates the live basket presentation counts into the tooltip', () => {
    registerLocale('main-toolbar-presentation', {
      'mainToolbar.presentationTooltip': 'Präsentation ({views} Ansichten, {entities} Elemente)',
    });
    setLocale('main-toolbar-presentation');
    useViewerStore.setState({
      models: new Map([['m1', makeModel()]]),
    } as Partial<ReturnType<typeof useViewerStore.getState>>);
    const container = render(<MainToolbar />);

    const { basketViews, pinboardEntities } = useViewerStore.getState();
    const expected = `Präsentation (${basketViews.length} Ansichten, ${pinboardEntities.size} Elemente)`;
    const button = [...container.querySelectorAll('button')].find(
      (b) => b.getAttribute('aria-label') === 'Show Presentation dock',
    );
    assert.ok(button, 'presentation dock button renders');
    act(() => button!.focus());
    const tooltip = document.body.querySelector('[role="tooltip"]');
    assert.equal(tooltip?.textContent, expected);
  });

  it('interpolates a workspace-panel label into the Panels trigger', () => {
    registerLocale('main-toolbar-panels-label', {
      'mainToolbar.panelsWithLabel': 'Bedienfelder: {label}',
    });
    setLocale('main-toolbar-panels-label');
    useViewerStore.setState({
      models: new Map([['m1', makeModel()]]),
    } as Partial<ReturnType<typeof useViewerStore.getState>>);
    const container = render(<MainToolbar />);

    // Open the Panels menu and check "BCF Topics" the way a user would, so
    // `workspacePanelLabel` (from `useWorkspacePanelControls`) goes from
    // null to non-empty and the interpolated form replaces the plain
    // "Panels" fallback on the trigger.
    const panelsTrigger = [...container.querySelectorAll('button[aria-haspopup="menu"]')].find((t) =>
      (t.getAttribute('aria-label') ?? '').startsWith('Bedienfelder') || t.getAttribute('aria-label') === 'Panels',
    );
    assert.ok(panelsTrigger, 'Panels trigger renders');
    act(() => panelsTrigger!.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, cancelable: true })));
    act(() => panelsTrigger!.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true })));
    const bcfItem = [...document.body.querySelectorAll('[role="menuitemcheckbox"]')].find(
      (el) => el.textContent === 'BCF Topics',
    );
    assert.ok(bcfItem, 'BCF Topics menu item renders');
    click(bcfItem!);

    const button = [...container.querySelectorAll('button')].find((b) =>
      (b.getAttribute('aria-label') ?? '').startsWith('Bedienfelder:'),
    );
    assert.ok(button, 'Panels trigger carries the interpolated workspace-panel label');
  });

  it('falls back to English per key for a partial locale', () => {
    registerLocale('main-toolbar-partial', {
      'mainToolbar.toolSelect': 'Auswählen',
      'mainToolbar.home': 'Start (Isometrisch + Sichtbarkeit zurücksetzen)',
    });
    setLocale('main-toolbar-partial');
    const container = render(<MainToolbar />);
    const strings = readableStrings(container);
    assert.ok(strings.has('Auswählen'), 'translated key renders in the registered locale');
    assert.ok(
      strings.has('Start (Isometrisch + Sichtbarkeit zurücksetzen)'),
      'translated key renders in the registered locale',
    );
    assert.ok(strings.has('Walk Mode'), 'untranslated key renders in English');
    assert.ok(strings.has('Show all (reset filters)') === false); // sanity: catalogue text is case-sensitive
    assert.ok(strings.has('Show All (Reset Filters)'), 'untranslated key renders in English, exact case');
  });
});
