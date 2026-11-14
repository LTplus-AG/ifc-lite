/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The catalogue and the gates agree, and the gates work.
 *
 * A catalogue entry is a promise to a host: "switch this off and your users
 * do not see it". The first test fails when an entry has no gate behind it,
 * so a feature cannot be listed before the code hides it. `GATED_SURFACES`
 * runs every surface that gates without a registry table; a gate table
 * (panels, commands, shortcuts) adds its ids to `GATE_TABLES`.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, click, render } from '@/test/render';
import { startAnalytics } from '@/lib/analytics';
import { usePrivacyDisclosure } from '@/hooks/usePrivacyDisclosure';
import { HostingAnalytics } from '@/components/HostingAnalytics';
import { AnalyticsConsentSection } from '@/components/viewer/settings/AnalyticsConsentSection';
import { useViewerStore } from '@/store';
import { enforcePanelAvailability } from '@/store/panel-availability-sync';
import { registerKeyboardCommand } from '@/lib/commands/dispatcher';
import { KEY_COMMAND_FEATURE, KEY_CONTEXT_FEATURE } from '@/lib/commands/keyboard-command-features';
import { PANEL_FEATURE, isPanelAvailable } from '@/lib/panels/availability';
import { renderPanelBody } from '@/lib/panels/renderPanelBody';
import { WORKSPACE_PANELS } from '@/lib/panels/registry';
import { HomeTab } from '@/components/viewer/ribbon/tabs/HomeTab';
import { COMMAND_FEATURE, COMMAND_PREFIX_FEATURE } from '@/components/viewer/surface-command-features';
import { paletteSurfaceCommands } from '@/components/viewer/surface-commands';
import { FEATURE_CATALOGUE, type FeatureId } from './catalogue';
import { featuresAskedForTest, resetFeaturesForTest } from './index';
import { TOOL_FEATURE, isToolAvailable } from './tools';
import { KEY_COMMANDS } from '@/lib/commands/keyboard-commands';
import { isKeyCommandAvailable } from '@/lib/commands/keyboard-command-features';
import { SURFACE_COMMANDS } from '@/components/viewer/surface-command-registry';
import { isSurfaceCommandAvailable } from '@/components/viewer/surface-command-features';
import { isTourAvailable } from '@/lib/tours/tour-availability';
import { BCF_TOUR } from '@/lib/tours/tours/bcf';
import { MEASURE_SECTION_TOUR } from '@/lib/tours/tours/measure-section';
import { WELCOME_TOUR } from '@/lib/tours/tours/welcome';
import { PanelGroupBrowser } from '@/components/viewer/ribbon/PanelGroupBrowser';
import { ShortcutsTab } from '@/components/viewer/ShortcutsTab';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';

function ShortcutHarness() {
  useKeyboardShortcuts();
  return null;
}

function PrivacyNoticeHost() {
  usePrivacyDisclosure();
  return null;
}

const named = (table: Partial<Record<string, FeatureId>>) => Object.values(table).filter((id) => id !== undefined);

/** Ids named by a registry gate table; each table's projection is driven below. */
const GATE_TABLES: readonly FeatureId[] = [
  ...named(PANEL_FEATURE),
  ...named(COMMAND_FEATURE),
  ...named(COMMAND_PREFIX_FEATURE),
  ...named(KEY_COMMAND_FEATURE),
  ...named(KEY_CONTEXT_FEATURE),
  ...named(TOOL_FEATURE),
];

const NOTHING = { default: 'none' } as const;
const PALETTE_STATE = { canEditInSession: true, cesiumAvailable: true, collabEnabled: true };

function paletteIds(): Set<string> {
  return new Set(paletteSurfaceCommands(PALETTE_STATE, () => {}).map((command) => command.id));
}

/** Surfaces with no registry: rendering or calling them asks about their feature. */
function runGatedSurfaces(): void {
  startAnalytics();
  render(<HostingAnalytics />);
  render(<PrivacyNoticeHost />);
  render(<AnalyticsConsentSection />);
}

afterEach(() => {
  cleanup();
  resetFeaturesForTest();
  useViewerStore.getState().showWorkspacePanel('properties');
});

describe('every catalogue feature has a gate behind it', () => {
  it('is named by a gate table or asked about by a surface that renders', () => {
    // Switched off, so asking is all the surfaces do (no analytics start, no script tag).
    resetFeaturesForTest({ default: 'none' });
    runGatedSurfaces();
    const gated = new Set<FeatureId>([...GATE_TABLES, ...featuresAskedForTest()]);
    const ungated = FEATURE_CATALOGUE.map((feature) => feature.id).filter((id) => !gated.has(id));
    assert.deepEqual(ungated, [], 'listed in the catalogue, but nothing hides it');
  });
});

describe('privacy features switched off', () => {
  it('the hosting analytics script is not injected', () => {
    resetFeaturesForTest({ default: 'all', disable: ['privacy.vercel-analytics'] });
    const before = document.querySelectorAll('script').length;
    const host = render(<HostingAnalytics />);
    assert.equal(document.querySelectorAll('script').length, before, 'no script element added');
    assert.equal(host.childElementCount, 0);
  });

  it('the analytics opt-out setting is not offered, since nothing is sent', () => {
    const shown = render(<AnalyticsConsentSection />);
    assert.notEqual(shown.textContent, '', 'offered by default');
    cleanup();
    resetFeaturesForTest({ default: 'all', disable: ['privacy.analytics'] });
    assert.equal(render(<AnalyticsConsentSection />).textContent, '');
  });
});

describe('panels, commands, shortcuts and tools switched off', () => {
  it('the command palette lists no command of a feature that is off', () => {
    const all = paletteIds();
    resetFeaturesForTest(NOTHING);
    const none = paletteIds();
    for (const id of ['tool:measure', 'tool:section', 'tool:walk', 'tool:annotate', 'panel:bcf', 'panel:script', 'panel:lens', 'measure:drag', 'schedule:generate']) {
      assert.equal(all.has(id), true, `${id} is offered by default`);
      assert.equal(none.has(id), false, `${id} must go with its feature`);
    }
    for (const id of ['view:home', 'tool:select', 'panel:properties', 'panel:tree', 'vis:hide', 'pref:settings']) {
      assert.equal(none.has(id), true, `${id} is baseline and stays`);
    }
  });

  it('a command comes back with exactly its own feature', () => {
    resetFeaturesForTest({ default: 'none', enable: ['tools.measure', 'check.bcf'] });
    const ids = paletteIds();
    assert.equal(ids.has('tool:measure'), true);
    assert.equal(ids.has('tool:section'), false);
    assert.equal(ids.has('panel:bcf'), true);
    assert.equal(ids.has('panel:clash'), false);
  });

  it('the ribbon renders no button for a command that is off', () => {
    resetFeaturesForTest({ default: 'all', disable: ['tools.measure', 'tools.section', 'tools.walk', 'tools.annotate'] });
    const band = render(<HomeTab />);
    const rendered = [...band.querySelectorAll('[data-command-id]')].map((node) => node.getAttribute('data-command-id'));
    for (const id of ['tool:measure', 'tool:section', 'tool:walk', 'tool:annotate']) assert.equal(rendered.includes(id), false, id);
    assert.equal(rendered.includes('tool:select'), true);
  });

  it('a panel that is off cannot be opened, restored or rendered', () => {
    const store = useViewerStore;
    store.getState().setBcfPanelVisible(true); // a layout persisted before the host configured anything
    resetFeaturesForTest({ default: 'none', enable: ['check.clash'] });
    const stop = enforcePanelAvailability(store);
    try {
      assert.equal(store.getState().bcfPanelVisible, false, 'closed on configuration');
      store.getState().openWorkspacePanel('bcf');
      store.getState().toggleBottomPanel('lists');
      store.getState().setBcfPanelVisible(true); // a direct setter, as other panels use
      assert.equal(store.getState().bcfPanelVisible, false);
      assert.equal(store.getState().listPanelVisible, false);
      assert.equal(store.getState().sidebarActivePanel, 'properties');
      store.getState().openWorkspacePanel('clash');
      assert.equal(store.getState().clashPanelVisible, true, 'an enabled panel still opens');
      assert.equal(renderPanelBody('bcf', () => {}), null, 'nothing rendered, so its chunk is never requested');
    } finally {
      stop();
    }
    const off = WORKSPACE_PANELS.filter((panel) => !isPanelAvailable(panel.id)).map((panel) => panel.id);
    assert.equal(off.includes('hierarchy') || off.includes('properties'), false, 'the baseline panels cannot be switched off');
  });

  it('enforcing availability keeps a change an earlier listener makes in the same update', () => {
    const store = useViewerStore;
    store.setState({ floatingPanels: [] });
    resetFeaturesForTest({ default: 'none', enable: ['check.clash'] });
    const at = { snap: 'free' as const, x: 0, y: 0, w: 300, h: 200 };
    // Subscribed before the rule, so it runs first and nests its own update.
    const stopEarlier = store.subscribe((state, previous) => {
      if (state.floatingPanels.some((panel) => panel.id === 'bcf') && !previous.floatingPanels.some((panel) => panel.id === 'bcf')) {
        store.setState({ floatingPanels: [...state.floatingPanels, { id: 'clash', ...at }] });
      }
    });
    const stop = enforcePanelAvailability(store);
    try {
      store.setState({ floatingPanels: [{ id: 'bcf', ...at }] });
      assert.deepEqual(store.getState().floatingPanels.map((panel) => panel.id), ['clash']);
    } finally {
      stop();
      stopEarlier();
      store.setState({ floatingPanels: [] });
    }
  });

  it('opening a panel that is off leaves the open panel where it was (#10147)', () => {
    const store = useViewerStore;
    resetFeaturesForTest({ default: 'none', enable: ['check.clash'] });
    const stop = enforcePanelAvailability(store);
    try {
      store.getState().openWorkspacePanel('clash');
      store.getState().setBcfPanelVisible(true); // e.g. a toast's Open link in the Clash panel
      assert.equal(store.getState().bcfPanelVisible, false);
      assert.equal(store.getState().clashPanelVisible, true, 'the Clash panel stays open');
      assert.equal(store.getState().sidebarActivePanel, 'clash');
    } finally {
      stop();
      store.getState().setClashPanelVisible(false);
    }
  });

  it('closing a switched-off primary never leaves Information in both split halves (#10147)', () => {
    const store = useViewerStore;
    resetFeaturesForTest({ default: 'none', enable: ['check.clash'] });
    store.setState({ sidebarActivePanel: 'lens', sidebarSecondaryPanel: 'properties' });
    const stop = enforcePanelAvailability(store);
    try {
      assert.equal(store.getState().sidebarActivePanel, 'properties');
      assert.equal(store.getState().sidebarSecondaryPanel, null);
    } finally {
      stop();
      store.setState({ sidebarSecondaryPanel: null });
    }
  });

  it('closing a panel while opening one that is off lands on an available panel (#10147)', () => {
    const store = useViewerStore;
    resetFeaturesForTest({ default: 'none', enable: ['check.clash', 'check.validation'] });
    const stop = enforcePanelAvailability(store);
    try {
      store.getState().openWorkspacePanel('clash');
      store.setState({ clashPanelVisible: false, bcfPanelVisible: true });
      assert.equal(store.getState().bcfPanelVisible, false);
      assert.equal(store.getState().sidebarActivePanel, 'properties', 'no stale active panel');
      store.setState({ bcfPanelVisible: true, idsPanelVisible: true });
      assert.equal(store.getState().bcfPanelVisible, false);
      assert.equal(store.getState().sidebarActivePanel, 'validation', 'the available panel opened in the same update is adopted');
    } finally {
      stop();
      store.setState({ clashPanelVisible: false, idsPanelVisible: false });
    }
  });

  it('a switched-off primary hands the sidebar to the next open panel (#10147)', () => {
    const store = useViewerStore;
    resetFeaturesForTest({ default: 'none', enable: ['check.clash'] });
    // A persisted layout, seeded flag by flag so exclusivity does not adopt Clash first: Lens on top, Clash flagged open.
    store.setState({ clashPanelVisible: true });
    store.setState({ sidebarActivePanel: 'lens' });
    const stop = enforcePanelAvailability(store);
    try {
      assert.equal(store.getState().sidebarActivePanel, 'clash');
    } finally {
      stop();
      store.setState({ clashPanelVisible: false });
    }
  });

  it('a tool that is off cannot be activated', () => {
    const store = useViewerStore;
    store.getState().setActiveTool('select');
    resetFeaturesForTest({ default: 'none', enable: ['tools.section'] });
    store.getState().setActiveTool('measure');
    assert.equal(store.getState().activeTool, 'select');
    store.getState().setActiveTool('section');
    assert.equal(store.getState().activeTool, 'section');
    store.getState().setActiveTool('select');
  });

  it('a shortcut that is off is not registered', () => {
    const press = () => window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'l', bubbles: true, cancelable: true }));
    let ran = 0;
    resetFeaturesForTest(NOTHING);
    const off = registerKeyboardCommand('tool.measure', () => { ran += 1; });
    press();
    off();
    assert.equal(ran, 0);
    resetFeaturesForTest();
    const on = registerKeyboardCommand('tool.measure', () => { ran += 1; });
    press();
    on();
    assert.equal(ran, 1, 'the same registration works when the feature is on');
  });
});

describe('one tool table, and what follows from it', () => {
  it('derives each tool\'s command and shortcut from TOOL_FEATURE, so the three agree', () => {
    for (const [tool, feature] of Object.entries(TOOL_FEATURE)) {
      const command = SURFACE_COMMANDS.find((entry) => entry.id === `tool:${tool}`);
      const key = KEY_COMMANDS.find((entry) => entry.id === `tool.${tool}`);
      assert.ok(command, `tool:${tool} is a registered command`);
      assert.ok(key, `tool.${tool} is a registered shortcut`);
      resetFeaturesForTest({ default: 'all', disable: [feature] });
      assert.equal(isToolAvailable(tool), false, tool);
      assert.equal(isSurfaceCommandAvailable(command), false, `tool:${tool}`);
      assert.equal(isKeyCommandAvailable(key), false, `tool.${tool}`);
      resetFeaturesForTest();
      assert.equal(isSurfaceCommandAvailable(command) && isKeyCommandAvailable(key), true, `${tool} back on`);
    }
  });

  it('offers a tour only while its panels and tools are on', () => {
    resetFeaturesForTest({ default: 'all', disable: ['check.bcf', 'tools.measure'] });
    assert.equal(isTourAvailable(BCF_TOUR), false, 'its panel is off');
    assert.equal(isTourAvailable(MEASURE_SECTION_TOUR), false, 'a tool it teaches is off');
    assert.equal(isTourAvailable(WELCOME_TOUR), true, 'the baseline tour stays');
  });

  it('lists switched-off panels in no shortcut row', () => {
    resetFeaturesForTest({ default: 'all', disable: ['check.bcf', 'check.compare'] });
    const text = render(<ShortcutsTab />).textContent ?? '';
    assert.doesNotMatch(text, /BCF Topics|Compare models/);
    assert.match(text, /Data validation/, 'the other panels of the Alt+digit row stay');
  });

  it('keeps each panel on its Alt+digit when one before it is off, and the dialog says which', () => {
    resetFeaturesForTest({ default: 'all', disable: ['check.bcf'] });
    render(<ShortcutHarness />);
    const altDigit = (digit: number) => {
      const event = new window.KeyboardEvent('keydown', { key: String(digit), code: `Digit${digit}`, altKey: true, bubbles: true, cancelable: true });
      act(() => { window.dispatchEvent(event); });
      return event.defaultPrevented;
    };
    assert.equal(altDigit(3), false, 'Alt+3 is still BCF\'s key, and with BCF off it goes to the browser');
    assert.equal(altDigit(4), true, 'Alt+4 still opens Data validation');
    assert.equal(useViewerStore.getState().sidebarActivePanel, 'validation');
    // The list no longer reads positionally once BCF is gone, so it names each key.
    const text = render(<ShortcutsTab />).textContent ?? '';
    assert.match(text, /4 Data validation/);
  });

  it('drops the bottom clause of the Alt+digit row when every bottom panel is off', () => {
    resetFeaturesForTest({ default: 'all', disable: ['automate.scripting', 'data.schedule', 'data.lists'] });
    const text = render(<ShortcutsTab />).textContent ?? '';
    assert.match(text, /Open a panel from the rail \(1 Properties[^)]*7 Extensions\)/);
    assert.doesNotMatch(text, /open at the bottom/);
  });

  // Pop-outs of switched-off panels: services/panel-windows.test.ts.

  it('puts a separator in the panel browser only between groups that render', () => {
    // Quantify and Site render nothing here. The first group (Coordinate) holds
    // Properties, which no host can switch off, so it always renders: this pins
    // the separator count rather than reproducing a reachable bug.
    resetFeaturesForTest({ default: 'none' });
    const ribbon = render(<PanelGroupBrowser />);
    const trigger = ribbon.querySelector<HTMLButtonElement>('button[aria-label="Browse panels"]');
    assert.ok(trigger);
    act(() => {
      trigger.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));
    });
    click(trigger);
    const menu = document.querySelector('[role="menu"]');
    assert.ok(menu);
    const first = menu.firstElementChild;
    assert.equal(first?.querySelector('[role="separator"]'), null, 'no separator before the first group');
    assert.equal(menu.querySelectorAll('[role="separator"]').length, menu.querySelectorAll('[data-panel-group]').length - 1);
  });
});
