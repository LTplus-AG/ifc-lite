/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The shared command surfaces MainToolbar hosts but does not own read the
 * i18n catalogue (#4918 slice 2, following slice 1's `MainToolbar.i18n.test.tsx`):
 * `ClassicExportMenuItems`, `CameraCommandMenuItems`, `BottomPanelMenuItems`,
 * `AuthorPanelMenuItems`, `ClassVisibilityMenuContent`.
 *
 * The oracle is a pseudo-locale that maps every `shared-commands.en.ts` key
 * to a marked copy of its English text. Each surface is mounted (in the
 * menu-open shell it needs to be visible), the visible/focusable strings
 * are read off in English, the locale is switched live, and every marked
 * string that was readable in English must reappear marked. A label left
 * hardcoded, or a consumer that does not re-render on a locale switch,
 * fails here by name.
 *
 * Two of the five surfaces (`export-commands.ts`, `camera-commands.ts`) are
 * plain data tables with no React import, so they carry a translation KEY
 * per row rather than text; this test exercises them through their real
 * renderers, the same as every other key here.
 */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cleanup, render } from '@/test/render.js';
import { registerLocale, setLocale, useTranslation, type Catalogue } from '@/i18n';
import { sharedCommandsEn } from '@/i18n/catalogues/shared-commands.en';
import { useViewerStore } from '@/store';
import { RibbonLargeButton } from '../ribbon/primitives.js';
import { RibbonExportGroup } from '../ribbon/tabs/RibbonExportGroup.js';
import { ClassicExportMenuItems } from './ClassicExportMenuItems.js';
import { EXPORT_COMMAND_IDS, type ExportIconSet } from './export-commands.js';
import { CameraCommandMenuItems, useCameraCommands } from './CameraCommands.js';
import { BottomPanelMenuItems } from './BottomPanelMenuItems.js';
import { AuthorPanelMenuItems } from './AuthorPanelMenuItems.js';
import { ClassVisibilityMenuContent } from './ClassVisibilityMenu.js';

/**
 * The ribbon's real icons come from `@/icons`, a Vite-only virtual module
 * (see `export-ui-parity.test.tsx`); this stub keeps `RibbonExportGroup`
 * renderable here, the same way that file does.
 */
function StubIcon(props: React.SVGProps<SVGSVGElement>) {
  return <svg {...props} />;
}
const STUB_EXPORT_ICONS = Object.fromEntries(
  EXPORT_COMMAND_IDS.map((id) => [id, StubIcon]),
) as ExportIconSet;

/**
 * A minimal stand-in for the ribbon View tab's camera cluster: it calls the
 * same `useCameraCommands()` hook and the same `t(command.labelKey)` /
 * `t(command.tooltipKey)` calls `ViewTab.tsx` makes, through the real
 * `RibbonLargeButton` primitive — without needing `@/icons`.
 */
function CameraCommandButtons() {
  const { t } = useTranslation();
  const commands = useCameraCommands();
  return (
    <>
      {commands.map((command) => (
        <RibbonLargeButton
          key={command.id}
          icon={StubIcon}
          label={t(command.labelKey)}
          tooltip={t(command.tooltipKey)}
          shortcut={command.shortcut}
          onClick={command.run}
        />
      ))}
    </>
  );
}

type SharedKey = keyof typeof sharedCommandsEn;
const KEYS = Object.keys(sharedCommandsEn) as SharedKey[];
const STATIC_KEYS = KEYS.filter((key) => !sharedCommandsEn[key].includes('{'));

/** Key-specific pseudo translation; keeps every `{placeholder}` of the English text. */
const mark = (key: SharedKey) => `⟦${key}|${sharedCommandsEn[key]}⟧`;
const PSEUDO: Catalogue = Object.fromEntries(KEYS.map((key) => [key, mark(key)]));

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

/** aria-labels, plain text, and every reachable Radix `TooltipContent` string. */
function readableStrings(container: HTMLElement): Set<string> {
  const out = new Set<string>();
  addReadable(document.body, out);
  for (const button of container.querySelectorAll('button')) {
    act(() => button.focus());
    addReadable(document.body, out);
    act(() => button.blur());
  }
  return out;
}

const STATE = {
  typeVisibility: {
    spaces: true,
    spatialZones: true,
    openings: true,
    virtualElements: true,
    site: true,
    ifcAnnotations: true,
    ifcGrid: true,
  },
  hasTypeGeometry: true,
  mergeLayers: true,
  geometryMode: 'fast',
  geomTierOverride: 'high',
} as unknown as Partial<ReturnType<typeof useViewerStore.getState>>;

const RESET = {
  typeVisibility: {
    spaces: false,
    spatialZones: false,
    openings: false,
    virtualElements: false,
    site: false,
    ifcAnnotations: false,
    ifcGrid: false,
  },
  hasTypeGeometry: false,
  mergeLayers: false,
  geomTierOverride: undefined,
} as unknown as Partial<ReturnType<typeof useViewerStore.getState>>;

/**
 * Keys this render cannot show, each for a stated reason:
 *  - the two fast/exact geometry-mode descriptions and the two
 *    pinned-detail descriptions are each one branch of a mutually
 *    exclusive ternary; this render's state (`geometryMode: 'fast'`)
 *    picks the other branch of each pair.
 *  - `pinnedDetail.label` interpolates `{tier}`, covered by
 *    `shared-commands.locale.i18n.test.tsx` instead.
 *  - the CSV table-menu's four item labels live in a Radix
 *    `DropdownMenuSub`, which opens on hover/keyboard rather than with its
 *    parent menu's `open` prop — not reachable without driving that
 *    interaction, which the classic/ribbon Export-cluster tests already
 *    cover for presence (`export-ui-parity.test.tsx`); this oracle proves
 *    the *mechanism* (`t(item.labelKey)`) is wired, via the header keys
 *    (`exportCommands.csv.label` / `.menuLabel` / `.tooltip`) instead.
 */
const NOT_RENDERED_IN_THIS_STATE: SharedKey[] = [
  'classVisibility.pinnedDetail.descriptionIgnored',
  'classVisibility.fastGeometry.descriptionExact',
  'exportCommands.csv.item.entities',
  'exportCommands.csv.item.properties',
  'exportCommands.csv.item.quantities',
  'exportCommands.csv.item.spatial',
  // Only rendered once an extension exporter is installed; translated in
  // `extensions-flavors-chrome.i18n.test.tsx` with one registered (#5838).
  'exportCommands.extension.groupLabel',
];

function renderAllSurfaces(): HTMLElement {
  return render(
    <div>
      {/* Chrome: the ribbon's own rendering of the same two data tables
          (RibbonExportGroup / a camera-command button cluster), which use
          `labelKey`/`tooltipKey` fields the classic menus below don't
          render (menu rows show `menuLabelKey` only; menu items carry no
          tooltip). */}
      <RibbonExportGroup icons={STUB_EXPORT_ICONS} />
      <CameraCommandButtons />
      <DropdownMenu open modal={false}>
        <DropdownMenuTrigger>Export</DropdownMenuTrigger>
        <DropdownMenuContent>
          <ClassicExportMenuItems />
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu open modal={false}>
        <DropdownMenuTrigger>Camera</DropdownMenuTrigger>
        <DropdownMenuContent>
          <CameraCommandMenuItems />
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu open modal={false}>
        <DropdownMenuTrigger>Panels</DropdownMenuTrigger>
        <DropdownMenuContent>
          <BottomPanelMenuItems active={new Set()} onToggle={() => {}} />
          <AuthorPanelMenuItems active={new Set()} canEdit onToggle={() => {}} />
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu open modal={false}>
        <DropdownMenuTrigger>Visibility</DropdownMenuTrigger>
        <ClassVisibilityMenuContent align="start" />
      </DropdownMenu>
    </div>,
  );
}

beforeEach(() => {
  setLocale('en');
  useViewerStore.setState(STATE);
});

afterEach(() => {
  cleanup();
  setLocale('en');
  useViewerStore.setState(RESET);
});

describe('shared command surfaces localization (#4918 slice 2)', () => {
  it('translates every static key rendered across the five shared surfaces', () => {
    const container = renderAllSurfaces();
    const english = readableStrings(container);

    registerLocale('shared-commands-pseudo', PSEUDO);
    act(() => setLocale('shared-commands-pseudo'));
    const after = readableStrings(container);

    const covered = new Set<SharedKey>();
    for (const key of STATIC_KEYS) {
      const text = sharedCommandsEn[key];
      if (!english.has(text)) continue; // not on screen in this render; checked below
      assert.ok(after.has(mark(key)), `${key}: "${text}" must be translated, marked text not found`);
      covered.add(key);
    }

    for (const key of covered) {
      assert.ok(
        !NOT_RENDERED_IN_THIS_STATE.includes(key),
        `${key}: covered by this render, drop it from NOT_RENDERED_IN_THIS_STATE`,
      );
    }
  });

  it('accounts for every static key: rendered here, or in NOT_RENDERED_IN_THIS_STATE', () => {
    const container = renderAllSurfaces();
    const english = readableStrings(container);

    const seen = STATIC_KEYS.filter((key) => english.has(sharedCommandsEn[key]));
    const unaccounted = STATIC_KEYS.filter(
      (key) => !seen.includes(key) && !NOT_RENDERED_IN_THIS_STATE.includes(key),
    );
    assert.deepEqual(unaccounted, [], 'key neither rendered nor listed in NOT_RENDERED_IN_THIS_STATE');

    const stale = NOT_RENDERED_IN_THIS_STATE.filter((key) => seen.includes(key));
    assert.deepEqual(stale, [], 'key listed as not-rendered but is actually on screen in this render');
  });
});
