/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Registered-locale behaviour of the shared command surfaces (#4918 slice
 * 2, following slice 1's `MainToolbar.locale.i18n.test.tsx`): the one
 * interpolated key (`classVisibility.pinnedDetail.label`, `{tier}`) and
 * per-key English fallback for a partial locale.
 *
 * Deliberately imports nothing this change added besides the components
 * and the pre-existing `@/i18n` registry, and names catalogue keys as
 * literals, so a revert of the shared-commands conversion still loads this
 * file and fails on its assertions instead of at import.
 */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cleanup, render } from '@/test/render.js';
import { registerLocale, setLocale } from '@/i18n';
import { useViewerStore } from '@/store';
import { ClassicExportMenuItems } from './ClassicExportMenuItems.js';
import { BottomPanelMenuItems } from './BottomPanelMenuItems.js';
import { ClassVisibilityMenuContent } from './ClassVisibilityMenu.js';

/**
 * Reads off `document.body`, not the mount container: Radix portals
 * `DropdownMenuContent` outside the container it was mounted under (see the
 * popper wrapper in the rendered DOM), so a container-scoped query would
 * silently miss every menu body this file asserts on.
 */
function readableStrings(_container: HTMLElement): Set<string> {
  const out = new Set<string>();
  document.body.querySelectorAll('*').forEach((element) => {
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
    geomTierOverride: undefined,
    geometryMode: 'exact',
  } as unknown as Partial<ReturnType<typeof useViewerStore.getState>>);
});

describe('shared command surfaces with a registered locale (#4918 slice 2)', () => {
  it('interpolates the pinned geometry tier into the translated label', () => {
    registerLocale('shared-commands-tier', {
      'classVisibility.pinnedDetail.label': 'Detailstufe fixiert: {tier}',
    });
    setLocale('shared-commands-tier');
    useViewerStore.setState({
      geomTierOverride: 'high',
      geometryMode: 'exact',
    } as unknown as Partial<ReturnType<typeof useViewerStore.getState>>);

    const container = render(
      <DropdownMenu open modal={false}>
        <DropdownMenuTrigger>Visibility</DropdownMenuTrigger>
        <ClassVisibilityMenuContent align="start" />
      </DropdownMenu>,
    );

    const strings = readableStrings(container);
    assert.ok(strings.has('Detailstufe fixiert: high'), 'pinned-detail label carries the interpolated tier');
  });

  it('falls back to English per key for a partial locale', () => {
    registerLocale('shared-commands-partial', {
      'exportCommands.ifc.menuLabel': 'IFC exportieren (mit Änderungen)',
      'workspacePanels.bottom.lists': 'Listen',
    });
    setLocale('shared-commands-partial');

    const container = render(
      <>
        <DropdownMenu open modal={false}>
          <DropdownMenuTrigger>Export</DropdownMenuTrigger>
          <DropdownMenuContent>
            <ClassicExportMenuItems />
          </DropdownMenuContent>
        </DropdownMenu>
        <DropdownMenu open modal={false}>
          <DropdownMenuTrigger>Panels</DropdownMenuTrigger>
          <DropdownMenuContent>
            <BottomPanelMenuItems active={new Set()} onToggle={() => {}} />
          </DropdownMenuContent>
        </DropdownMenu>
      </>,
    );

    const strings = readableStrings(container);
    assert.ok(strings.has('IFC exportieren (mit Änderungen)'), 'translated key renders in the registered locale');
    assert.ok(strings.has('Listen'), 'translated key renders in the registered locale');
    assert.ok(strings.has('Export GLB (3D Model)'), 'untranslated key renders in English, exact case');
    assert.ok(strings.has('Schedule (Gantt)'), 'untranslated key renders in English, exact case');
  });
});
