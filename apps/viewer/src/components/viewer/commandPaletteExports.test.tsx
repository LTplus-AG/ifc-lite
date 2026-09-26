/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The command palette's Export category is the toolbar export registry, run
 * through the toolbars' own handlers and dialogs (#5601). Before this, the
 * palette carried a second export implementation that offered a different
 * set of formats, exported GLB without its dialog, and only `console.error`ed
 * when an export failed. Style: `toolbar/export-ui-parity.test.tsx`.
 */

import '@/test/setup-dom.js';
// A real (fake) IndexedDB, as in CommandPalette.locale.i18n.test.tsx: without
// it the palette's recent-files lookup warns with "ReferenceError: indexedDB is
// not defined", which the revert oracle reads as a load failure and so misses
// this file's real assertion failures.
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { act, StrictMode, type ComponentProps } from 'react';
import { GeometryProcessor } from '@ifc-lite/geometry';
import type { BimContext } from '@ifc-lite/sdk';
import type { IfcDataStore } from '@ifc-lite/parser';
import { BimReactContext } from '@/sdk/BimProvider.js';
import { cleanup, render } from '@/test/render.js';
import { downloadedNames, clearDownloads } from '@/test/download-capture';
import { resolveEnglish } from '@/i18n/registry';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
// Bare specifier, matching what the code under test imports, so the spy
// watches the same module instance (see export-ui-parity.test.tsx).
import { toast } from '@/components/ui/toast';
import { posthog } from '@/lib/analytics';
import { EXPORT_COMMANDS, EXPORT_COMMAND_IDS } from './toolbar/export-commands.js';
import { buildCommandPaletteCommands, type CommandPaletteBuildParams } from './commandPaletteCommands.js';
import { CommandPalette } from './CommandPalette.js';
import { usePaletteExportRunner } from './usePaletteExportRunner.js';
import { parseFixtureModel } from './anonymized-export/anonymized-export-fixture.test-support';

const PARAMS: CommandPaletteBuildParams = {
  execute: () => {},
  recentFiles: [],
  cachedNames: { current: new Set() },
  extensionCommands: [],
  extensionHost: null,
  canEditInSession: true,
  cesiumAvailable: false,
  activateRightPanel: () => {},
  activateBottomPanel: () => {},
  runExport: () => {},
};

/** A data store whose entity table throws on first read — every data export fails. */
function brokenDataStore(): IfcDataStore {
  const store = {
    source: { byteLength: 4, materialize: () => new Uint8Array(4) },
    get entities(): never {
      throw new Error('entity table unreadable');
    },
  };
  // One widening cast at the store boundary, as in export-ui-parity.test.tsx.
  return store as unknown as IfcDataStore;
}

// Under StrictMode, as the app runs: it replays mount effects, which is what
// would re-click (and so close) a dialog's auto-open trigger.
function renderPalette(): void {
  render(
    <StrictMode>
      <BimReactContext.Provider value={{} as BimContext}>
        <CommandPalette open onOpenChange={() => {}} />
      </BimReactContext.Provider>
    </StrictMode>,
  );
}

let paletteRunner: ReturnType<typeof usePaletteExportRunner> | null = null;
function PaletteRunnerHarness() {
  paletteRunner = usePaletteExportRunner();
  return paletteRunner.dialog;
}

/** Click the palette row whose label starts with `prefix`, then let its deferred action run. */
async function runRow(prefix: RegExp): Promise<void> {
  const row = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')]
    .find((el) => prefix.test(el.textContent ?? ''));
  assert.ok(row, `no palette row matching ${prefix}`);
  await act(async () => {
    row.click();
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
}

beforeEach(() => {
  useViewerStore.setState({ ifcDataStore: null, geometryResult: null, models: new Map(), scheduleIsEdited: false });
});

afterEach(() => {
  cleanup();
  clearDownloads();
  useViewerStore.setState({ ifcDataStore: null, geometryResult: null, models: new Map(), scheduleIsEdited: false });
  paletteRunner = null;
});

describe('command palette exports (#5601)', () => {
  it('forwards palette surface to every registered export dialog (#5844)', async () => {
    const model = fixtureModel('m');
    useViewerStore.setState({ ...fixtureModels(model), ifcDataStore: model.ifcDataStore, scheduleIsEdited: true });
    const dialogs = EXPORT_COMMANDS.filter((command) => command.kind === 'dialog');
    const originals = dialogs.map((command) => ({ command, Dialog: command.Dialog }));
    const seen: string[] = [];
    try {
      for (const { command, Dialog } of originals) {
        Reflect.set(command, 'Dialog', (props: ComponentProps<typeof Dialog>) => {
          assert.equal(props.surface, 'palette');
          seen.push(command.id);
          return null;
        });
      }
      render(<BimReactContext.Provider value={{} as BimContext}><PaletteRunnerHarness /></BimReactContext.Provider>);
      for (const command of dialogs) {
        await act(async () => {
          assert.ok(paletteRunner);
          paletteRunner.runExport({ id: command.id });
        });
      }
      assert.deepEqual(seen, dialogs.map((command) => command.id));
    } finally {
      for (const { command, Dialog } of originals) Reflect.set(command, 'Dialog', Dialog);
    }
  });

  it('offers exactly the registry formats, in registry order', () => {
    const ids = buildCommandPaletteCommands(PARAMS)
      .filter((cmd) => cmd.category === 'Export')
      // CSV is one row per table: `export:csv-<table>` all belong to `csv`.
      .map((cmd) => cmd.id.replace(/^export:/, '').replace(/^csv-.*/, 'csv'))
      .filter((id, index, all) => all.indexOf(id) === index);
    assert.deepEqual(ids, [...EXPORT_COMMAND_IDS]);
  });

  it('offers every CSV table the registry lists', () => {
    const csv = EXPORT_COMMANDS.find((c) => c.id === 'csv');
    assert.ok(csv && csv.kind === 'table-menu');
    const rows = buildCommandPaletteCommands(PARAMS)
      .filter((cmd) => cmd.id.startsWith('export:csv-'))
      .map((cmd) => cmd.id);
    assert.deepEqual(rows, csv.items.map((item) => `export:csv-${item.type}`));
  });

  it('a failing export from the palette surfaces an error toast', async () => {
    useViewerStore.setState({ ifcDataStore: brokenDataStore() });
    const errors: string[] = [];
    const completions: unknown[] = [];
    const spy = mock.method(toast, 'error', (message: string) => { errors.push(message); });
    const analytics = mock.method(posthog, 'capture', (event: string) => {
      if (event === 'export_completed') completions.push(event);
    });
    const quiet = mock.method(console, 'error', () => {});
    try {
      renderPalette();
      await runRow(/^Export JSON/);
    } finally {
      spy.mock.restore();
      analytics.mock.restore();
      quiet.mock.restore();
    }
    assert.equal(errors.length, 1, `expected one error toast, saw ${errors.length}`);
    assert.match(errors[0], /JSON export failed/);
    assert.deepEqual(completions, [], '#5844: a failed export must not emit a completion');
  });

  it('a successful palette JSON download emits one completion with palette surface (#5844)', async () => {
    useViewerStore.setState({
      ifcDataStore: {
        source: { byteLength: 4, materialize: () => new Uint8Array(4) },
        entities: { count: 0 },
      } as unknown as IfcDataStore,
    });
    const events: Array<{ event: string; properties: Record<string, unknown> }> = [];
    const spy = mock.method(posthog, 'capture', (event: string, properties: Record<string, unknown>) => {
      events.push({ event, properties });
    });
    try {
      renderPalette();
      await runRow(/^Export JSON/);
    } finally {
      spy.mock.restore();
    }
    assert.deepEqual(events.filter(({ event }) => event === 'export_completed'), [
      { event: 'export_completed', properties: { format: 'json', surface: 'palette', row_count: 0 } },
    ]);
  });

  it('each palette CSV table and screenshot emits one completion for its download (#5844)', async () => {
    const ifcDataStore = await parseFixtureModel();
    const model = { ...fixtureModel('m'), ifcDataStore };
    useViewerStore.setState({ ...fixtureModels(model), ifcDataStore });
    const csv = EXPORT_COMMANDS.find((command) => command.id === 'csv');
    assert.ok(csv && csv.kind === 'table-menu');
    const canvas = document.createElement('canvas');
    canvas.dataset.viewport = 'main';
    canvas.toDataURL = () => 'data:image/png;base64,AA==';
    document.body.appendChild(canvas);
    const events: Array<{ event: string; properties: Record<string, unknown> }> = [];
    const analytics = mock.method(posthog, 'capture', (event: string, properties: Record<string, unknown>) => {
      events.push({ event, properties });
    });
    const init = mock.method(GeometryProcessor.prototype, 'init', async () => undefined);
    const exportCsv = mock.method(GeometryProcessor.prototype, 'exportCsv', () => new TextEncoder().encode('a,b\n'));
    const dispose = mock.method(GeometryProcessor.prototype, 'dispose', () => undefined);
    try {
      render(<BimReactContext.Provider value={{} as BimContext}><PaletteRunnerHarness /></BimReactContext.Provider>);
      for (const item of csv.items) {
        const before = events.length;
        await act(async () => {
          assert.ok(paletteRunner);
          paletteRunner.runExport({ id: 'csv', table: item.type });
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
        assert.deepEqual(events.slice(before).filter(({ event }) => event === 'export_completed'), [
          { event: 'export_completed', properties: { format: 'csv', surface: 'palette' } },
        ], `CSV ${item.type} must record exactly one completion`);
      }
      const before = events.length;
      await act(async () => {
        assert.ok(paletteRunner);
        paletteRunner.runExport({ id: 'screenshot' });
      });
      assert.deepEqual(events.slice(before).filter(({ event }) => event === 'export_completed'), [
        { event: 'export_completed', properties: { format: 'png', surface: 'palette' } },
      ]);
      assert.equal(downloadedNames().length, csv.items.length + 1, 'one browser download per completion');
      assert.equal(exportCsv.mock.callCount(), csv.items.length, 'every registered CSV table reached the writer');
    } finally {
      analytics.mock.restore();
      init.mock.restore();
      exportCsv.mock.restore();
      dispose.mock.restore();
      canvas.remove();
    }
  });

  it('GLB opens the same export dialog the toolbars use', async () => {
    useViewerStore.setState({
      ifcDataStore: { source: { byteLength: 4 } } as unknown as IfcDataStore,
    });
    renderPalette();
    await runRow(/^Export GLB/);
    const title = resolveEnglish('geometryExport.glb.dialogTitle');
    const dialogs = [...document.body.querySelectorAll('[role="dialog"]')];
    assert.ok(
      dialogs.some((d) => d.textContent?.includes(title)),
      'the palette GLB row must open the GLB export dialog',
    );
  });

  it('says so instead of doing nothing when a CSV export has no source bytes', async () => {
    // A store with no source bytes (e.g. server-backed) passes the registry's
    // `dataStore` gate, but the CSV handler has nothing to serialize.
    useViewerStore.setState({
      ifcDataStore: { source: { byteLength: 0 } } as unknown as IfcDataStore,
    });
    const infos: string[] = [];
    const spy = mock.method(toast, 'info', (message: string) => { infos.push(message); });
    try {
      renderPalette();
      await runRow(/^Export CSV: Entities/);
    } finally {
      spy.mock.restore();
    }
    assert.deepEqual(infos, [resolveEnglish('commandPalette.export.unavailable')]);
  });

  it('says so instead of doing nothing when there is nothing to export', async () => {
    const infos: string[] = [];
    const spy = mock.method(toast, 'info', (message: string) => { infos.push(message); });
    try {
      renderPalette();
      await runRow(/^Export JSON/);
    } finally {
      spy.mock.restore();
    }
    assert.deepEqual(infos, [resolveEnglish('commandPalette.export.unavailable')]);
  });
});
