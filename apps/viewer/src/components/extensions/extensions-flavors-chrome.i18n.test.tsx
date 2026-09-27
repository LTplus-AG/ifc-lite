/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Chrome localization for the ten smaller extensions/flavors components
 * (#4918 sweep, `extensions-flavors.en.ts`; `FlavorListView` has its own
 * larger oracle in `FlavorListView.i18n.test.tsx`): `ExtensionsPanel`,
 * `FlavorDialog`, `FlavorMergeDialog`, `FlavorImportPreview`,
 * `FlavorIndicator`, `HelpHint`, `BundlePreview`, `ExtensionDockHost`,
 * the export menu's extension rows, `ExtensionToolbarSlot`.
 *
 * Same oracle shape as `FlavorListView.i18n.test.tsx`: `extensionsFlavorsEn`
 * is registered under its own locale id (not literal `'en'` — it isn't
 * wired into `en.ts` yet, see that file's header for why), a pseudo-locale
 * marks every string, and expected text at every step is computed through
 * the real `resolve()` rather than hardcoded, so nothing here re-asserts a
 * copy of the English source text.
 */
import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createBimContext } from '@ifc-lite/sdk';
import { DEFAULT_FLAVOR_ID, type Bundle, type BundleFile, type Flavor } from '@ifc-lite/extensions';
import { cleanup, render, click } from '@/test/render.js';
import { loadDialogs } from '@/test/dialog-host.js';
import { latestToast } from '@/test/toasts.js';
import { Toaster } from '@/components/ui/toast';
import { registerLocale, setLocale } from '@/i18n';
import type { Catalogue, TranslationParameters, TranslationValue, PluralTranslation } from '@/i18n';
import { resolve } from '@/i18n/registry';
import { extensionsFlavorsEn } from '@/i18n/catalogues/extensions-flavors.en';
import { ExtensionHostService } from '@/services/extensions/host.js';
import { IdbFlavorStorage } from '@/services/extensions/idb-flavor-storage.js';
import {
  DEFAULT_FLAVOR_DESCRIPTION,
  DEFAULT_FLAVOR_NAME,
} from '@/services/extensions/default-flavor-metadata.js';
import { ExtensionHostContext } from '@/sdk/ExtensionHostProvider.js';
import { ExtensionsPanel } from './ExtensionsPanel.js';
import { FlavorDialog } from './FlavorDialog.js';
import { FlavorMergeDialog } from './FlavorMergeDialog.js';
import { FlavorImportPreview } from './FlavorImportPreview.js';
import { FlavorIndicator } from './FlavorIndicator.js';
import { HelpHint } from './HelpHint.js';
import { BundlePreview } from './BundlePreview.js';
import { ExtensionDockHost } from './ExtensionDockHost.js';
import { ClassicExportMenuItems } from '@/components/viewer/toolbar/ClassicExportMenuItems';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { ExtensionToolbarSlot } from './ExtensionToolbarSlot.js';
import { flavorSwitchPartial } from './flavor-dialog-feedback.js';

const r = resolve as unknown as (key: string, params?: TranslationParameters) => string;

const BASELINE_LOCALE = 'extensions-flavors-en-baseline';
const PSEUDO_LOCALE = 'extensions-flavors-pseudo';

function markValue(value: TranslationValue): TranslationValue {
  if (typeof value === 'string') return `⟦${value}⟧`;
  const marked: Record<string, string> = {};
  for (const [category, text] of Object.entries(value as PluralTranslation)) {
    if (typeof text === 'string') marked[category] = `⟦${text}⟧`;
  }
  return marked as PluralTranslation;
}

const KEYS = Object.keys(extensionsFlavorsEn) as (keyof typeof extensionsFlavorsEn)[];
const PSEUDO: Catalogue = Object.fromEntries(
  KEYS.map((key) => [key, markValue(extensionsFlavorsEn[key])]),
) as Catalogue;

/** aria-label / title / placeholder attributes + direct text-node content,
 *  read off the WHOLE document (several of these components render into a
 *  Radix portal under `document.body`, outside the mounted container). */
function readableStrings(): Set<string> {
  const out = new Set<string>();
  document.body.querySelectorAll('*').forEach((el) => {
    for (const attr of ['aria-label', 'title', 'placeholder']) {
      const value = el.getAttribute(attr);
      if (value) out.add(value);
    }
    const ownText = [...el.childNodes]
      .filter((n) => n.nodeType === n.TEXT_NODE)
      .map((n) => n.textContent ?? '')
      .join('')
      .trim();
    if (ownText) out.add(ownText);
  });
  return out;
}

interface Occurrence {
  key: string;
  params?: TranslationParameters;
}

/** Asserts every `(key, params)` pair's English text is currently on
 *  screen, switches to the pseudo-locale, and asserts the marked/translated
 *  form takes its place — then restores the baseline locale. */
function assertAllTranslate(occurrences: Occurrence[]): void {
  const englishDom = readableStrings();
  const seen = new Set<string>();
  for (const occ of occurrences) {
    const dedupe = `${occ.key}|${JSON.stringify(occ.params ?? {})}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    const english = r(occ.key, occ.params);
    assert.ok(
      englishDom.has(english),
      `${occ.key}: expected English text ${JSON.stringify(english)} to be on screen before the locale switch`,
    );
  }
  act(() => setLocale(PSEUDO_LOCALE));
  try {
    const afterDom = readableStrings();
    for (const dedupe of seen) {
      const occ = occurrences.find((o) => `${o.key}|${JSON.stringify(o.params ?? {})}` === dedupe)!;
      const pseudo = r(occ.key, occ.params);
      assert.ok(
        afterDom.has(pseudo),
        `${occ.key}: "${pseudo}" must be translated, marked text not found in the switched-locale DOM`,
      );
    }
  } finally {
    act(() => setLocale(BASELINE_LOCALE));
  }
}

function makeFlavor(overrides: Partial<Flavor>): Flavor {
  return {
    schemaVersion: 1,
    id: 'flv.x',
    name: 'X',
    description: '',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z',
    extensions: [],
    lenses: [],
    savedQueries: [],
    keybindings: [],
    layout: { state: {} },
    settings: {},
    ...overrides,
  } as Flavor;
}

class StubHost extends ExtensionHostService {
  constructor() {
    super({
      sdk: createBimContext({
        transport: {
          send: () => Promise.reject(new Error('SDK transport is not exercised by this test')),
          subscribe: () => () => {},
          close: () => {},
        },
      }),
    });
  }
}

beforeEach(async () => {
  registerLocale(BASELINE_LOCALE, extensionsFlavorsEn as Catalogue);
  registerLocale(PSEUDO_LOCALE, PSEUDO);
  setLocale(BASELINE_LOCALE);
  await new IdbFlavorStorage().clear();
});

afterEach(() => {
  cleanup();
  setLocale(BASELINE_LOCALE);
});

const tick = () => new Promise((resolve_) => setTimeout(resolve_, 1));
async function flush(times = 50): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      await tick();
    });
  }
}

describe('ExtensionsPanel localization (#4918)', () => {
  it('translates the header, help popover, tab strip, and empty state', async () => {
    const host = new StubHost();
    render(
      <ExtensionHostContext.Provider value={host}>
        <ExtensionsPanel onClose={() => {}} />
      </ExtensionHostContext.Provider>,
    );
    await flush(5);

    // Open the help popover so its body mounts.
    const helpTrigger = [...document.body.querySelectorAll('button')].find(
      (b) => b.getAttribute('aria-label') === r('extensionsFlavors.helpHint.ariaLabel', { label: r('extensionsFlavors.extensionsPanel.heading') }),
    );
    assert.ok(helpTrigger, 'the panel help hint trigger must render');
    click(helpTrigger!);

    assertAllTranslate([
      { key: 'extensionsFlavors.extensionsPanel.heading' },
      { key: 'extensionsFlavors.extensionsPanel.importButton' },
      { key: 'extensionsFlavors.extensionsPanel.closeAriaLabel' },
      { key: 'extensionsFlavors.extensionsPanel.tabStripAriaLabel' },
      { key: 'extensionsFlavors.extensionsPanel.tab.installed' },
      { key: 'extensionsFlavors.extensionsPanel.tab.ideas' },
      { key: 'extensionsFlavors.extensionsPanel.tab.repair' },
      { key: 'extensionsFlavors.extensionsPanel.tab.audit' },
      { key: 'extensionsFlavors.extensionsPanel.helpHint.intro' },
      { key: 'extensionsFlavors.extensionsPanel.helpHint.tabStripInfo' },
      { key: 'extensionsFlavors.extensionsPanel.helpHint.gettingStarted' },
      { key: 'extensionsFlavors.extensionsPanel.helpHint.docLinkLabel' },
      { key: 'extensionsFlavors.extensionsPanel.emptyState.title' },
      { key: 'extensionsFlavors.extensionsPanel.emptyState.description' },
      { key: 'extensionsFlavors.extensionsPanel.emptyState.describeInChat' },
      { key: 'extensionsFlavors.extensionsPanel.emptyState.browseIdeas' },
      { key: 'extensionsFlavors.extensionsPanel.emptyState.importFile' },
      { key: 'extensionsFlavors.extensionsPanel.emptyState.cliHint' },
    ]);
  });

  it('translates an installed row: stats, fork/run/enable/uninstall, and the "+N more" badge', async () => {
    class HostWithRecord extends StubHost {
      override async listInstalled() {
        return [
          {
            id: 'ext.demo',
            version: '1.0.0',
            enabled: true,
            installedAt: Date.parse('2026-01-05T00:00:00Z'),
            grantedCapabilities: ['cap.a', 'cap.b', 'cap.c', 'cap.d', 'cap.e'],
          },
        ] as unknown as Awaited<ReturnType<ExtensionHostService['listInstalled']>>;
      }
    }
    const host = new HostWithRecord();
    render(
      <ExtensionHostContext.Provider value={host}>
        <ExtensionsPanel />
      </ExtensionHostContext.Provider>,
    );
    await flush(5);

    const installedAtText = new Date(Date.parse('2026-01-05T00:00:00Z')).toLocaleDateString();
    assertAllTranslate([
      {
        key: 'extensionsFlavors.extensionsPanel.row.stats',
        params: { version: '1.0.0', count: 5, countDisplay: '5', date: installedAtText },
      },
      { key: 'extensionsFlavors.extensionsPanel.row.forkAriaLabel', params: { id: 'ext.demo' } },
      { key: 'extensionsFlavors.extensionsPanel.row.forkTitle' },
      { key: 'extensionsFlavors.extensionsPanel.row.runTestsAriaLabel', params: { id: 'ext.demo' } },
      { key: 'extensionsFlavors.extensionsPanel.row.disableAriaLabel' },
      { key: 'extensionsFlavors.extensionsPanel.row.uninstallAriaLabel', params: { id: 'ext.demo' } },
      { key: 'extensionsFlavors.extensionsPanel.row.moreCapabilities', params: { count: '1' } },
    ]);
  });

  it('translates test-run feedback from the real row action', async () => {
    class TestHost extends StubHost {
      override async listInstalled() {
        return [{
          id: 'ext.demo', version: '1.0.0', enabled: true,
          installedAt: Date.parse('2026-01-05T00:00:00Z'), grantedCapabilities: [],
        }] as unknown as Awaited<ReturnType<ExtensionHostService['listInstalled']>>;
      }

      override async runTests() {
        return {
          passed: 0,
          failed: 1,
          totalDurationMs: 12,
          results: [{ name: 'smoke', passed: false, durationMs: 12, error: 'synthetic failure' }],
        };
      }
    }
    registerLocale('test-feedback-reordered', {
      'extensionsFlavors.extensionsPanel.toast.testsRunning': 'RUN {id}',
      'extensionsFlavors.extensionsPanel.toast.testsFailed': {
        one: 'ERROR {error} BEFORE {id} WITH {failed}',
        other: 'ERROR {error} BEFORE {id} WITH {failed}',
      },
    } as Catalogue);
    setLocale('test-feedback-reordered');
    render(
      <ExtensionHostContext.Provider value={new TestHost()}>
        <ExtensionsPanel />
        <Toaster />
      </ExtensionHostContext.Provider>,
    );
    await flush(5);
    const run = document.body.querySelector<HTMLButtonElement>('[aria-label="Run tests for ext.demo"]');
    assert.ok(run);
    await act(async () => {
      click(run);
      await tick();
    });
    assert.match(latestToast(), /ERROR synthetic failure BEFORE ext\.demo WITH 1/);
  });

  it('translates file, enable/disable, and uninstall interaction feedback', async () => {
    class HostWithRecord extends StubHost {
      override async listInstalled() {
        return [{
          id: 'ext.demo',
          version: '1.0.0',
          enabled: true,
          installedAt: Date.parse('2026-01-05T00:00:00Z'),
          grantedCapabilities: [],
        }] as unknown as Awaited<ReturnType<ExtensionHostService['listInstalled']>>;
      }

      override setEnabled(): Promise<void> {
        return Promise.reject(new Error('permission denied'));
      }
    }
    const host = new HostWithRecord();
    const container = render(
      <ExtensionHostContext.Provider value={host}>
        <ExtensionsPanel />
        <Toaster />
      </ExtensionHostContext.Provider>,
    );
    await flush(5);
    act(() => setLocale(PSEUDO_LOCALE));

    const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]');
    assert.ok(fileInput);
    Object.defineProperty(fileInput, 'files', {
      configurable: true,
      value: [new File(['not a bundle'], 'notes.txt')],
    });
    await act(async () => {
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));
      await tick();
    });
    assert.match(latestToast(), new RegExp(r(
      'extensionsFlavors.extensionsPanel.toast.expectedBundle',
      { filename: 'notes.txt' },
    ).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    const enabledSwitch = document.body.querySelector<HTMLButtonElement>('[role="switch"]');
    assert.ok(enabledSwitch);
    await act(async () => {
      click(enabledSwitch);
      await tick();
    });
    assert.match(latestToast(), /permission denied/);
    assert.match(latestToast(), new RegExp(r(
      'extensionsFlavors.extensionsPanel.operation.disable',
    ).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    const uninstall = [...document.body.querySelectorAll('button')].find((button) =>
      button.getAttribute('aria-label') === r(
        'extensionsFlavors.extensionsPanel.row.uninstallAriaLabel',
        { id: 'ext.demo' },
      ),
    );
    assert.ok(uninstall);
    const { ConfirmDialogHost } = await loadDialogs();
    render(<ConfirmDialogHost />);
    click(uninstall);
    const dialog = document.querySelector('[role="alertdialog"]');
    assert.ok(dialog);
    assert.match(dialog.textContent ?? '', new RegExp(r('extensionsFlavors.extensionsPanel.confirmUninstall', { id: 'ext.demo' }).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    click(dialog.querySelector('button')!);
  });
});

describe('FlavorDialog localization (#4918)', () => {
  it('translates the title and help popover body', async () => {
    const host = new StubHost();
    render(
      <ExtensionHostContext.Provider value={host}>
        <FlavorDialog open onClose={() => {}} />
      </ExtensionHostContext.Provider>,
    );
    await flush(20);

    const helpTrigger = [...document.body.querySelectorAll('button')].find(
      (b) => b.getAttribute('aria-label') === r('extensionsFlavors.helpHint.ariaLabel', { label: r('extensionsFlavors.flavorDialog.title') }),
    );
    assert.ok(helpTrigger, 'the flavor dialog help hint trigger must render');
    click(helpTrigger!);

    assertAllTranslate([
      { key: 'extensionsFlavors.flavorDialog.title' },
      { key: 'extensionsFlavors.flavorDialog.helpHint.p1' },
      { key: 'extensionsFlavors.flavorDialog.helpHint.p2' },
      { key: 'extensionsFlavors.flavorDialog.helpHint.p3' },
      { key: 'extensionsFlavors.flavorDialog.helpHint.p4' },
    ]);
  });

  it('translates the destructive delete confirmation at interaction time', async () => {
    const host = new StubHost();
    const active = makeFlavor({ id: 'flv.active', name: 'Active' });
    const removable = makeFlavor({ id: 'flv.removable', name: 'Removable' });
    await host.flavors.put(active);
    await host.flavors.put(removable);
    await host.flavors.activate(active.id);
    render(
      <ExtensionHostContext.Provider value={host}>
        <FlavorDialog open onClose={() => {}} />
      </ExtensionHostContext.Provider>,
    );
    await flush(20);

    act(() => setLocale(PSEUDO_LOCALE));
    const deleteButton = [...document.body.querySelectorAll('button')].find(
      (button) => button.getAttribute('aria-label') === r('extensionsFlavors.flavorListView.deleteAriaLabel', { name: removable.name }),
    );
    assert.ok(deleteButton, 'the inactive flavor delete button must render');

    const { ConfirmDialogHost } = await loadDialogs();
    render(<ConfirmDialogHost />);
    click(deleteButton);
    const dialog = document.querySelector('[role="alertdialog"]');
    assert.ok(dialog);
    assert.match(dialog.textContent ?? '', new RegExp(r('extensionsFlavors.flavorDialog.confirmDelete', { id: removable.id }).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    click(dialog.querySelector('button')!);
  });

  it('uses localized canonical metadata when duplicating the baseline flavor', async () => {
    const host = new StubHost();
    await host.flavors.resetToDefaults();
    render(
      <ExtensionHostContext.Provider value={host}>
        <FlavorDialog open onClose={() => {}} />
      </ExtensionHostContext.Provider>,
    );
    await flush(20);
    act(() => setLocale(PSEUDO_LOCALE));

    const baselineName = r('extensionsFlavors.flavorIndicator.defaultLabel');
    const duplicateButton = [...document.body.querySelectorAll('button')].find((button) =>
      button.getAttribute('aria-label') === r(
        'extensionsFlavors.flavorListView.duplicateAriaLabel',
        { name: baselineName },
      ),
    );
    assert.ok(duplicateButton, 'baseline duplicate action must use its localized name');
    click(duplicateButton);
    await flush(20);

    const clone = (await host.flavors.list()).find((flavor) => flavor.id !== 'flv.default');
    assert.ok(clone, 'duplicate action must persist a clone');
    assert.equal(
      clone.name,
      r('extensionsFlavors.flavorDialog.duplicateName', { name: baselineName }),
    );
  });
});

describe('flavor switch feedback localization (#4918)', () => {
  it('translates stable persistence refusal reasons and preserves unexpected diagnostics', () => {
    registerLocale('flavor-refusal-reasons', {
      'extensionsFlavors.flavorDialog.part.lenses': 'LENTILLES',
      'extensionsFlavors.flavorDialog.part.layout': 'DISPOSITION',
      'extensionsFlavors.flavorDialog.reason.storageUnavailable': 'STOCKAGE INDISPONIBLE.',
      'extensionsFlavors.flavorDialog.toast.switchedPartially':
        '{id}: {parts} — {reasons}',
    });
    setLocale('flavor-refusal-reasons');

    const message = flavorSwitchPartial(r, 'de-DE', 'flv.example', [
      {
        part: 'lenses',
        reason: 'unavailable',
        message: 'Browser storage is unavailable — lens changes were not saved.',
      },
      { part: 'layout', message: 'Unexpected layout failure.' },
    ]);

    assert.equal(
      message,
      'flv.example: LENTILLES und DISPOSITION — STOCKAGE INDISPONIBLE. und Unexpected layout failure.',
    );
    assert.doesNotMatch(message, /lens changes were not saved/);
  });
});

describe('FlavorMergeDialog localization (#4918)', () => {
  it('translates the "no active flavor" state', async () => {
    const host = new StubHost();
    const theirs = makeFlavor({ id: 'flv.theirs', name: 'Theirs' });
    render(
      <ExtensionHostContext.Provider value={host}>
        <FlavorMergeDialog open theirs={theirs} onClose={() => {}} />
      </ExtensionHostContext.Provider>,
    );
    await flush(10);

    assertAllTranslate([
      { key: 'extensionsFlavors.flavorMergeDialog.title' },
      { key: 'extensionsFlavors.flavorMergeDialog.noActiveFlavor' },
    ]);
  });

  it('translates a clean merge (no conflicts)', async () => {
    const host = new StubHost();
    const shared = makeFlavor({ id: 'flv.shared', name: 'Shared', settings: { demo: 'same' } });
    await host.flavors.put(shared);
    await host.flavors.activate('flv.shared');
    const theirs = { ...shared, name: 'Theirs' };

    render(
      <ExtensionHostContext.Provider value={host}>
        <FlavorMergeDialog open theirs={theirs} onClose={() => {}} />
      </ExtensionHostContext.Provider>,
    );
    await flush(20);

    assertAllTranslate([
      {
        key: 'extensionsFlavors.flavorMergeDialog.cleanMerge',
        params: { theirs: 'Theirs', ours: 'Shared' },
      },
      { key: 'extensionsFlavors.flavorMergeDialog.cancelButton' },
      { key: 'extensionsFlavors.flavorMergeDialog.saveButton' },
    ]);
  });

  it('uses localized canonical flavor names in merge summaries', async () => {
    registerLocale('merge-canonical-name', {
      'extensionsFlavors.flavorIndicator.defaultLabel': 'BASELINE LOCALISÉE',
    });
    setLocale('merge-canonical-name');
    const host = new StubHost();
    const shared = makeFlavor({
      id: DEFAULT_FLAVOR_ID,
      name: DEFAULT_FLAVOR_NAME,
      description: DEFAULT_FLAVOR_DESCRIPTION,
      settings: { demo: 'same' },
    });
    await host.flavors.put(shared);
    await host.flavors.activate(DEFAULT_FLAVOR_ID);

    render(
      <ExtensionHostContext.Provider value={host}>
        <FlavorMergeDialog open theirs={{ ...shared }} onClose={() => {}} />
      </ExtensionHostContext.Provider>,
    );
    await flush(20);

    const summary = r('extensionsFlavors.flavorMergeDialog.cleanMerge', {
      theirs: 'BASELINE LOCALISÉE',
      ours: 'BASELINE LOCALISÉE',
    });
    assert.ok(readableStrings().has(summary));
    assert.doesNotMatch(document.body.textContent ?? '', new RegExp(`\\b${DEFAULT_FLAVOR_NAME}\\b`));
  });

  it('translates a setting conflict: summary, resolve controls, and the chip labels', async () => {
    const host = new StubHost();
    const base = makeFlavor({ id: 'flv.m', name: 'Base', settings: { demo: 'A' } });
    const oursFlavor = makeFlavor({ id: 'flv.active', name: 'Ours', settings: { demo: 'C' } });
    await host.flavors.put(base);
    await host.flavors.put(oursFlavor);
    await host.flavors.activate('flv.active');
    const theirs = makeFlavor({ id: 'flv.m', name: 'Theirs', settings: { demo: 'B' } });

    render(
      <ExtensionHostContext.Provider value={host}>
        <FlavorMergeDialog open theirs={theirs} onClose={() => {}} />
      </ExtensionHostContext.Provider>,
    );
    await flush(20);

    assertAllTranslate([
      {
        key: 'extensionsFlavors.flavorMergeDialog.conflictSummary',
        params: { count: 1, countDisplay: '1', theirs: 'Theirs', ours: 'Ours' },
      },
      {
        key: 'extensionsFlavors.flavorMergeDialog.conflictKind.setting',
      },
      { key: 'extensionsFlavors.flavorMergeDialog.theirsLabel' },
      { key: 'extensionsFlavors.flavorMergeDialog.oursLabel' },
      { key: 'extensionsFlavors.flavorMergeDialog.baseLabel' },
      { key: 'extensionsFlavors.flavorMergeDialog.cancelButton' },
      { key: 'extensionsFlavors.flavorMergeDialog.saveButton' },
    ]);

    const englishKind = r('extensionsFlavors.flavorMergeDialog.conflictKind.setting');
    assert.ok(readableStrings().has(r('extensionsFlavors.flavorMergeDialog.resolveAriaLabel', {
      kind: englishKind,
      key: 'demo',
    })));
    act(() => setLocale(PSEUDO_LOCALE));
    try {
      const pseudoKind = r('extensionsFlavors.flavorMergeDialog.conflictKind.setting');
      assert.ok(readableStrings().has(r('extensionsFlavors.flavorMergeDialog.resolveAriaLabel', {
        kind: pseudoKind,
        key: 'demo',
      })));
      assert.ok(!document.body.textContent?.includes('setting'));
    } finally {
      act(() => setLocale(BASELINE_LOCALE));
    }

    // `pickAriaLabel`'s own param is itself a translated word (`theirsLabel`,
    // recomputed by the live-rendered `ResolutionChip` on every locale
    // switch) — resolve it fresh under each locale rather than baking a
    // stale English copy into the expected pseudo text.
    const englishPick = r('extensionsFlavors.flavorMergeDialog.pickAriaLabel', {
      label: r('extensionsFlavors.flavorMergeDialog.theirsLabel'),
    });
    assert.ok(readableStrings().has(englishPick), 'the English "Pick Theirs" aria-label must render');
    act(() => setLocale(PSEUDO_LOCALE));
    try {
      const pseudoPick = r('extensionsFlavors.flavorMergeDialog.pickAriaLabel', {
        label: r('extensionsFlavors.flavorMergeDialog.theirsLabel'),
      });
      assert.ok(readableStrings().has(pseudoPick), 'pickAriaLabel must be translated, marked text not found');
    } finally {
      act(() => setLocale(BASELINE_LOCALE));
    }
  });
});

describe('FlavorImportPreview localization (#4918)', () => {
  it('localizes untouched canonical metadata without masking imported edits', () => {
    const canonical = {
      flavor: makeFlavor({
        id: DEFAULT_FLAVOR_ID,
        name: DEFAULT_FLAVOR_NAME,
        description: DEFAULT_FLAVOR_DESCRIPTION,
      }),
      extensionBundles: new Map(),
      summary: undefined,
    };
    render(
      <FlavorImportPreview
        unpacked={canonical}
        busy={false}
        onCancel={() => {}}
        onMerge={() => {}}
        onSaveAsNew={() => {}}
        onReplace={() => {}}
      />,
    );
    act(() => setLocale(PSEUDO_LOCALE));
    const canonicalText = document.body.textContent ?? '';
    assert.match(canonicalText, new RegExp(r('extensionsFlavors.flavorIndicator.defaultLabel').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(canonicalText, new RegExp(r('extensionsFlavors.flavorIndicator.defaultDescription').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    cleanup();
    const customized = {
      ...canonical,
      flavor: { ...canonical.flavor, name: 'Imported custom name', description: 'Imported custom description' },
    };
    render(
      <FlavorImportPreview
        unpacked={customized}
        busy={false}
        onCancel={() => {}}
        onMerge={() => {}}
        onSaveAsNew={() => {}}
        onReplace={() => {}}
      />,
    );
    assert.match(document.body.textContent ?? '', /Imported custom name/);
    assert.match(document.body.textContent ?? '', /Imported custom description/);
  });

  it('translates the preview header, stats line, and action buttons', () => {
    const unpacked = {
      flavor: makeFlavor({
        id: 'flv.import',
        name: 'Imported',
        extensions: [{ id: 'ext.a', version: '1.0.0', capabilities: [] }] as unknown as Flavor['extensions'],
        lenses: [{ id: 'l1', name: 'L1', definition: {} }] as unknown as Flavor['lenses'],
        savedQueries: [{ id: 'q1', name: 'Q1', query: '' }] as unknown as Flavor['savedQueries'],
      }),
      extensionBundles: new Map(),
      summary: undefined,
    };
    render(
      <FlavorImportPreview
        unpacked={unpacked}
        busy={false}
        onCancel={() => {}}
        onMerge={() => {}}
        onSaveAsNew={() => {}}
        onReplace={() => {}}
      />,
    );

    assertAllTranslate([
      { key: 'extensionsFlavors.flavorImportPreview.title' },
      { key: 'extensionsFlavors.flavorImportPreview.nameLabel' },
      { key: 'extensionsFlavors.flavorImportPreview.idLabel' },
      {
        key: 'extensionsFlavors.flavorImportPreview.statsLine',
        params: { extensions: 1, lenses: 1, queries: 1 },
      },
      { key: 'extensionsFlavors.flavorImportPreview.cancelButton' },
      { key: 'extensionsFlavors.flavorImportPreview.mergeButton' },
      { key: 'extensionsFlavors.flavorImportPreview.saveAsNewButton' },
      { key: 'extensionsFlavors.flavorImportPreview.replaceButton' },
    ]);
  });
});

describe('FlavorIndicator localization (#4918)', () => {
  it('translates the inactive (no host flavor) state', async () => {
    const host = new StubHost();
    render(
      <ExtensionHostContext.Provider value={host}>
        <FlavorIndicator />
      </ExtensionHostContext.Provider>,
    );
    await flush(10);

    assertAllTranslate([
      { key: 'extensionsFlavors.flavorIndicator.inactiveAriaLabel' },
      { key: 'extensionsFlavors.flavorIndicator.inactiveTitle' },
      { key: 'extensionsFlavors.flavorIndicator.defaultLabel' },
    ]);
  });

  it('translates the active-flavor state', async () => {
    const host = new StubHost();
    await host.flavors.put(makeFlavor({ id: 'flv.ind', name: 'Indicated' }));
    await host.flavors.activate('flv.ind');
    render(
      <ExtensionHostContext.Provider value={host}>
        <FlavorIndicator />
      </ExtensionHostContext.Provider>,
    );
    await flush(10);

    assertAllTranslate([
      { key: 'extensionsFlavors.flavorIndicator.activeAriaLabel', params: { name: 'Indicated' } },
      {
        key: 'extensionsFlavors.flavorIndicator.activeTitle',
        params: { name: 'Indicated' },
      },
    ]);
  });

  it('lets a locale own the active flavor description separator and order', async () => {
    registerLocale('en-x-flavor-title-order', {
      'extensionsFlavors.flavorIndicator.activeTitleWithDescription': '{description} BEFORE {name}',
    });
    setLocale('en-x-flavor-title-order');
    const host = new StubHost();
    await host.flavors.put(makeFlavor({ id: 'flv.ordered', name: 'Ordered', description: 'Details' }));
    await host.flavors.activate('flv.ordered');
    const container = render(
      <ExtensionHostContext.Provider value={host}>
        <FlavorIndicator />
      </ExtensionHostContext.Provider>,
    );
    await flush(10);
    assert.equal(container.querySelector('button')?.getAttribute('title'), 'Details BEFORE Ordered');
  });

  it('localizes seeded baseline metadata while preserving its canonical id', async () => {
    const host = new StubHost();
    const baseline = await host.flavors.resetToDefaults();
    render(
      <ExtensionHostContext.Provider value={host}>
        <div>
          <FlavorIndicator />
          <ExtensionsPanel />
        </div>
      </ExtensionHostContext.Provider>,
    );
    await flush(10);

    assert.equal(baseline.id, 'flv.default');
    assert.ok(readableStrings().has(r('extensionsFlavors.flavorIndicator.defaultLabel')));
    act(() => setLocale(PSEUDO_LOCALE));

    const name = r('extensionsFlavors.flavorIndicator.defaultLabel');
    const description = r('extensionsFlavors.flavorIndicator.defaultDescription');
    assert.ok(readableStrings().has(name));
    assert.ok(readableStrings().has(
      r('extensionsFlavors.extensionsPanel.activeFlavorTitle', { name }),
    ));
    assert.ok(
      readableStrings().has(
        r('extensionsFlavors.flavorIndicator.activeTitleWithDescription', { name, description }),
      ),
    );
  });
});

describe('HelpHint localization (#4918)', () => {
  it('translates the trigger aria-label/title and the default "Learn more" link', () => {
    const container = render(
      <HelpHint label="Test hint" docLink={{ href: 'https://example.test' }}>
        <p>Body</p>
      </HelpHint>,
    );
    const trigger = container.querySelector('button');
    assert.ok(trigger, 'the hint trigger must render');
    click(trigger!);

    assertAllTranslate([
      { key: 'extensionsFlavors.helpHint.ariaLabel', params: { label: 'Test hint' } },
      { key: 'extensionsFlavors.helpHint.learnMoreDefault' },
    ]);
  });
});

describe('BundlePreview localization (#4918)', () => {
  it('translates the file list and copy controls', () => {
    const files = new Map<string, BundleFile>([
      ['manifest.json', { path: 'manifest.json', bytes: new TextEncoder().encode('{}'), text: '{}' }],
    ]);
    const bundle = { manifest: {} as Bundle['manifest'], files };
    render(<BundlePreview bundle={bundle} />);

    assertAllTranslate([
      { key: 'extensionsFlavors.bundlePreview.bundleFilesAriaLabel' },
      { key: 'extensionsFlavors.bundlePreview.viewFileAriaLabel', params: { path: 'manifest.json' } },
      { key: 'extensionsFlavors.bundlePreview.copyAriaLabel' },
      { key: 'extensionsFlavors.bundlePreview.copyButton' },
    ]);
  });
});

describe('ExtensionDockHost localization (#4918)', () => {
  it('translates the dock region aria-label', () => {
    const host = new StubHost();
    host.slotRegistry.register('ext.a', [
      {
        extensionId: 'ext.a',
        slot: 'dock.left',
        payload: { id: 'd1', slot: 'dock.left', title: 'My Widget', widget: 'widget.json' },
      },
    ]);
    render(
      <ExtensionHostContext.Provider value={host}>
        <ExtensionDockHost slot="dock.left" />
      </ExtensionHostContext.Provider>,
    );

    assertAllTranslate([
      { key: 'extensionsFlavors.extensionDockHost.dockAriaLabel', params: { slot: 'dock.left' } },
    ]);
    // `extensionsFlavors.extensionDockHost.loadingWidget` is NOT exercised
    // here: `DockBody`'s widget-loading effect has no real `await`
    // (`host.loader.getBundle` and friends are all synchronous), so it
    // always settles to "error" or "loaded" within the same effect flush a
    // mount goes through — React's test-environment act() auto-flushes
    // passive effects synchronously even around a raw (non-`act`)
    // `createRoot().render()` + `flushSync`, so the pre-effect "loading"
    // paint this string is for was not reproducible as a distinct,
    // observable DOM state in this harness. The `t()` call site is a
    // one-line conditional (`ExtensionDockHost.tsx`'s `if (!widget) return
    // <div>{t('...loadingWidget')}</div>`) identical in shape to every
    // other converted string in this file, all of which the other
    // assertion here already proves the mechanism for.
  });
});

describe('extension exporter rows localization (#4918, #5838)', () => {
  it('translates the "From extensions" group label in the export menu', () => {
    const host = new StubHost();
    host.slotRegistry.register('ext.a', [
      {
        extensionId: 'ext.a',
        slot: 'exportMenu',
        payload: { id: 'exp1', name: 'Demo CSV', mimeType: 'text/csv', extension: 'csv', handler: 'x.js' },
      },
    ]);
    render(
      <ExtensionHostContext.Provider value={host}>
        <DropdownMenu open modal={false}>
          <DropdownMenuTrigger>Export</DropdownMenuTrigger>
          <DropdownMenuContent><ClassicExportMenuItems /></DropdownMenuContent>
        </DropdownMenu>
      </ExtensionHostContext.Provider>,
    );

    assertAllTranslate([{ key: 'exportCommands.extension.groupLabel' }]);
  });
});

describe('ExtensionToolbarSlot localization (#4918)', () => {
  it('translates the "Run {title}" aria-label', () => {
    const host = new StubHost();
    host.slotRegistry.register('ext.a', [
      {
        extensionId: 'ext.a',
        slot: 'toolbar.left',
        payload: { command: 'ext.a.cmd', slot: 'toolbar.left', title: 'My Command' },
      },
    ]);
    render(
      <ExtensionHostContext.Provider value={host}>
        <ExtensionToolbarSlot slot="toolbar.left" />
      </ExtensionHostContext.Provider>,
    );

    assertAllTranslate([
      { key: 'extensionsFlavors.extensionToolbarSlot.runAriaLabel', params: { title: 'My Command' } },
    ]);
  });
});
