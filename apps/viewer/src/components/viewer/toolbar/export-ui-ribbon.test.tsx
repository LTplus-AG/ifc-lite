/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Ribbon export reachability, gating and actions (#2510, #2511, #5874). */

import '@/test/setup-dom.js';
import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { TooltipProvider } from '@/components/ui/tooltip.js';
import { useViewerStore } from '@/store/index.js';
// Bare specifiers, matching what the code under test imports: a `.js`-suffixed
// copy could resolve to a second module instance, and the toast spy would then
// watch an object nothing calls.
import { toast } from '@/components/ui/toast';
import { posthog } from '@/lib/analytics';
import type { FederatedModel } from '@/store/types';
import type { IfcDataStore } from '@ifc-lite/parser';
import { GeometryProcessor } from '@ifc-lite/geometry';
import { EVENT_FILE_DOWNLOADED } from '@/lib/tours/events.js';
import { installViewportCaptureBoundary } from '@/test/viewport-capture-boundary.js';
import {
  EXPORT_COMMANDS,
  EXPORT_COMMAND_IDS,
  type ExportIconSet,
} from './export-commands.js';
import { RibbonExportGroup } from '../ribbon/tabs/RibbonExportGroup.js';
import { RIBBON_EXPORT_ICONS } from '../ribbon/tabs/ribbon-export-icons.js';
import { FileTab } from '../ribbon/tabs/FileTab.js';
import type { FileCommands } from './useFileCommands.js';
import { useExportCommands } from './useExportCommands.js';

/**
 * The real `FileCommands` contract, TYPED rather than cast: none of these are
 * invoked here, so a cast would let the shape drift underneath the mount.
 */
const FILE_COMMANDS: FileCommands = {
  fileInputs: null,
  openShareDialog: () => {},
  handleOpenClick: async () => {},
  handleAddModelClick: async () => {},
  handleRefresh: async () => {},
  canRefresh: false,
  hasModelsLoaded: true,
};

/**
 * The ribbon's real icons come from `@/icons`, which resolves through
 * `unplugin-icons` and cannot be loaded by the node test runner; the component
 * takes the set as a prop so it stays renderable here. The real set is covered
 * by `ribbon icon set covers every registered format` below.
 */
function StubIcon(props: React.SVGProps<SVGSVGElement>) {
  return <svg {...props} />;
}
/** Every key an icon set carries: one per registered format, plus the extension-exporter row icon (#5838). */
const ICON_KEYS: (keyof ExportIconSet)[] = [...EXPORT_COMMAND_IDS, 'extension'];
const STUB_ICONS = Object.fromEntries(
  ICON_KEYS.map((id) => [id, StubIcon]),
) as ExportIconSet;

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

function render(node: React.ReactNode): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<TooltipProvider>{node}</TooltipProvider>);
  });
  mounted.push({ root, container });
  return container;
}

/** The ribbon's Export cluster: the File tab's Export group. */
function renderRibbonExports(): void {
  render(<RibbonExportGroup icons={STUB_ICONS} />);
}

let exportEntitiesCsv: (() => Promise<void>) | null = null;
function CsvExportHarness() {
  const { handleExportCSV } = useExportCommands('ribbon');
  exportEntitiesCsv = () => handleExportCSV('entities');
  return null;
}

/** Export ids currently on screen, in DOM order. */
function renderedExportIds(): string[] {
  return [...document.body.querySelectorAll('[data-export-command]')].map(
    (el) => el.getAttribute('data-export-command') ?? '',
  );
}

function exportControl(id: string): HTMLElement {
  const el = document.body.querySelector<HTMLElement>(`[data-export-command="${id}"]`);
  assert.ok(el, `an export control for "${id}" must be on screen`);
  return el;
}

/**
 * Tear down everything mounted so far, then PROVE the screen is empty before
 * the next surface is rendered.
 *
 * Every query in this file is global (`document.body`), and Radix portals its
 * menus and dialogs OUTSIDE the test container — so anything that outlived its
 * root would silently answer the second surface's assertions with the first
 * surface's DOM, and a ribbon that opened nothing would read as a pass. That
 * path is not reachable today (React does remove the portal on unmount), so
 * these two assertions are a latch on an invariant the tests depend on rather
 * than a live bug fix: `forceMount` on a future dialog, a root that fails to
 * unmount, or collapsing this loop into a single `act()` would each re-open it.
 *
 * Each root is unmounted in its OWN `act()`: one `act()` around the whole loop
 * batches the work, and a component that never actually tore down then looks
 * exactly like one that did.
 */
function unmountAll(): void {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  assert.deepEqual(
    renderedExportIds(),
    [],
    'export controls outlived their root — a later surface would be asserted against this one',
  );
  assert.equal(
    document.body.querySelector('[role="dialog"]'),
    null,
    'a dialog outlived its root — a later surface would be asserted against this one',
  );
}

/**
 * Exactly the slice of `IfcDataStore` the export handlers touch, with every
 * member's type taken FROM the real store rather than restated. A fake typed
 * `as any` compiles no matter what the real contract does; this one goes red
 * the moment a member it stands in for changes shape, which is the whole
 * reason for having it.
 */
type ExportDataStoreSlice = {
  source: Pick<IfcDataStore['source'], 'byteLength' | 'materialize'>;
  entities: Pick<
    IfcDataStore['entities'],
    'count' | 'expressId' | 'getGlobalId' | 'getName' | 'getTypeName'
  >;
  properties: Pick<IfcDataStore['properties'], 'getForEntity'>;
};

/**
 * Minimal data store: enough for the JSON export to walk one entity, and
 * enough for the CSV/JSON gate (`requires: 'dataStore'`) to open. Annotated at
 * the declaration, so the literal is checked against the real member types
 * before the single widening cast in `loadFakeModel` is applied.
 */
function fakeDataStore(): ExportDataStoreSlice {
  return {
    source: { byteLength: 4, materialize: () => new Uint8Array([1, 2, 3, 4]) },
    entities: {
      count: 1,
      // Uint32Array, not Int32Array: the `as any` cast this fake used to carry
      // accepted the wrong element type silently for as long as it existed.
      expressId: new Uint32Array([1]),
      getGlobalId: () => '0000000000000000000001',
      getName: () => 'Wall',
      getTypeName: () => 'IfcWall',
    },
    properties: { getForEntity: () => [] },
  };
}

function loadFakeModel(): void {
  // One widening cast, at the store boundary and nowhere else: the object it
  // widens has already been checked against `ExportDataStoreSlice` above.
  useViewerStore.setState({ ifcDataStore: fakeDataStore() as unknown as IfcDataStore });
}

/**
 * `n` loaded models. Fully typed against `FederatedModel` — no cast — because
 * only `models.size` is read here and every required member has a real value.
 */
function fakeFederation(n: number): Map<string, FederatedModel> {
  const entries: Array<[string, FederatedModel]> = [];
  for (let i = 0; i < n; i++) {
    entries.push([
      `model-${i}`,
      {
        id: `model-${i}`,
        name: `model-${i}.ifc`,
        ifcDataStore: null,
        geometryResult: null,
        visible: true,
        collapsed: false,
        schemaVersion: 'IFC4',
        loadedAt: 0,
        fileSize: 0,
        idOffset: 0,
        maxExpressId: 0,
      },
    ]);
  }
  return new Map(entries);
}

/**
 * The message of the single success toast raised while `run` executed. Spying
 * on the real `toast` object (the same module instance the hook imports) means
 * a spy that never fired shows up as a count mismatch, not as a silent pass.
 */
async function captureSuccessToast(run: () => Promise<void> | void): Promise<string> {
  const messages: string[] = [];
  const spy = mock.method(toast, 'success', (message: string) => {
    messages.push(message);
  });
  try {
    await run();
  } finally {
    spy.mock.restore();
  }
  assert.equal(messages.length, 1, `expected exactly one success toast, saw ${messages.length}`);
  return messages[0];
}

/** Filenames (by extension) downloaded while `run` executed. */
async function captureDownloads(run: () => Promise<void> | void): Promise<string[]> {
  const kinds: string[] = [];
  const listener = (e: Event) => {
    kinds.push((e as CustomEvent<{ kind: string }>).detail.kind);
  };
  window.addEventListener(EVENT_FILE_DOWNLOADED, listener);
  try {
    await run();
  } finally {
    window.removeEventListener(EVENT_FILE_DOWNLOADED, listener);
  }
  return kinds;
}

beforeEach(() => {
  useViewerStore.setState({ ifcDataStore: null, geometryResult: null, models: new Map() });
});

afterEach(() => {
  exportEntitiesCsv = null;
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

describe('ribbon export UI (#2510, #2511, #5874)', () => {
  it('the registry is internally consistent', () => {
    const ids = EXPORT_COMMANDS.map((c) => c.id);
    assert.deepEqual([...EXPORT_COMMAND_IDS], ids, 'EXPORT_COMMAND_IDS must mirror the registry');
    assert.equal(new Set(ids).size, ids.length, 'export command ids must be unique');
    assert.ok(ids.length > 0, 'the registry must not be empty');
  });

  it('the ribbon renders every registered export format', () => {
    renderRibbonExports();
    assert.deepEqual(renderedExportIds(), [...EXPORT_COMMAND_IDS]);
  });

  it('forwards the initiating surface to every registered dialog (#5844)', () => {
    const seen = new Map<string, Set<string>>();
    const dialogs = EXPORT_COMMANDS.filter((command) => command.kind === 'dialog');
    const originals = dialogs.map((command) => ({ command, Dialog: command.Dialog }));
    try {
      for (const { command, Dialog } of originals) {
        Reflect.set(command, 'Dialog', (props: React.ComponentProps<typeof Dialog>) => {
          const surfaces = seen.get(command.id) ?? new Set<string>();
          assert.ok(props.surface, 'registry dialogs must carry a surface');
          surfaces.add(props.surface);
          seen.set(command.id, surfaces);
          return <Dialog {...props} />;
        });
      }
      renderRibbonExports();
      assert.deepEqual([...seen.entries()].map(([id, surfaces]) => [id, [...surfaces]]),
        dialogs.map((command) => [command.id, ['ribbon']]));
    } finally {
      unmountAll();
      for (const { command, Dialog } of originals) Reflect.set(command, 'Dialog', Dialog);
    }
  });

  it('gates every format with no model loaded (#2511)', () => {
    renderRibbonExports();
    const ribbonOff = renderedExportIds().filter((id) => {
      const el = exportControl(id);
      return el.hasAttribute('disabled') || el.getAttribute('data-disabled') !== null;
    });

    assert.deepEqual(ribbonOff, [...EXPORT_COMMAND_IDS], 'nothing is exportable with no model loaded');
  });

  it('the ribbon icon set covers every registered format', () => {
    // Imported, not read as source (#2434). The old comment said `@/icons`
    // "resolves only through the Vite plugin, so the real map cannot be
    // imported here" — the `src/test/` loader hooks collapse every `~icons/*`
    // specifier onto a stub, so it can. That matters: the source form counted
    // KEYS THAT LOOK LIKE KEYS, so a key inside a nested object or a commented
    // block counted, and an entry whose value failed to resolve did not.
    assert.deepEqual(Object.keys(RIBBON_EXPORT_ICONS).sort(), [...ICON_KEYS].sort());
    for (const id of ICON_KEYS) {
      assert.ok(RIBBON_EXPORT_ICONS[id], `the ribbon icon for ${id} must resolve to a component`);
    }
  });

  it('the File tab actually hosts its export cluster (#2510)', () => {
    loadFakeModel();
    render(<FileTab fileCommands={FILE_COMMANDS} />);
    assert.deepEqual(
      renderedExportIds().sort(),
      [...EXPORT_COMMAND_IDS].sort(),
      'the ribbon File tab must host the whole registry, with its icon set wired through',
    );
  });

  it('the JSON export actually downloads a file from the ribbon', async () => {
    loadFakeModel();
    const events: Array<{ event: string; properties: Record<string, unknown> }> = [];
    const capture = mock.method(posthog, 'capture', (event: string, properties: Record<string, unknown>) => {
      events.push({ event, properties });
    });

    try {
    renderRibbonExports();
    const fromRibbon = await captureDownloads(async () => {
      await act(async () => {
        exportControl('json').click();
      });
    });
    assert.deepEqual(fromRibbon, ['json'], 'the ribbon JSON button must produce a download');
    assert.deepEqual(events.filter(({ event }) => event === 'export_completed'), [
      { event: 'export_completed', properties: { format: 'json', surface: 'ribbon', row_count: 1 } },
    ], '#5844: one completion per successful download with its initiating surface');
    } finally {
      capture.mock.restore();
    }
  });

  it('the screenshot export saves a PNG from the ribbon (#2511)', async () => {
    // The second `kind: 'action'` command, and the one that had already drifted
    // (the ribbon offered it with no model loaded). Asserting the *extension*
    // rather than "something downloaded" is what makes a cross-wired dispatch —
    // both action ids landing on the same handler — fail here.
    loadFakeModel();
    const canvas = document.createElement('canvas');
    canvas.dataset.viewport = 'main';
    canvas.toDataURL = () => 'data:image/png;base64,iVBORw0KGgo=';
    document.body.appendChild(canvas);
    // #6709: downloads use the owned viewport boundary; this UI fixture does
    // not mount the canonical loop or claim a physical GPU submission.
    const releaseViewport = installViewportCaptureBoundary(canvas);
    const presentation = mock.method(globalThis, 'requestAnimationFrame', (callback: FrameRequestCallback) => {
      queueMicrotask(() => callback(0));
      return 0;
    });
    const events: Array<{ event: string; properties: Record<string, unknown> }> = [];
    const capture = mock.method(posthog, 'capture', (event: string, properties: Record<string, unknown>) => {
      events.push({ event, properties });
    });

    try {
      renderRibbonExports();
      const fromRibbon = await captureDownloads(async () => {
        const downloaded = new Promise<void>(resolve => {
          window.addEventListener(EVENT_FILE_DOWNLOADED, () => resolve(), { once: true });
        });
        await act(async () => {
          exportControl('screenshot').click();
          await downloaded;
        });
      });
      assert.deepEqual(fromRibbon, ['png'], 'the ribbon Screenshot button must save a PNG');
      assert.deepEqual(events.filter(({ event }) => event === 'export_completed'), [
        { event: 'export_completed', properties: { format: 'png', surface: 'ribbon' } },
      ], '#5844: screenshot completions retain the initiating surface');
    } finally {
      capture.mock.restore();
      releaseViewport();
      presentation.mock.restore();
      canvas.remove();
    }
  });

  it('reports when a data export covers the active model only (#2511)', async () => {
    // CSV/JSON read the one active `ifcDataStore`, so a federated session gets
    // a partial export. A partial export must not be reported as a whole one.
    loadFakeModel();
    useViewerStore.setState({ models: fakeFederation(3) });

    renderRibbonExports();
    const ribbonToast = await captureSuccessToast(async () => {
      await act(async () => {
        exportControl('json').click();
      });
    });
    assert.match(ribbonToast, /active model only, 2 other loaded models not included/);

    // ...and a single-model session must NOT carry the note.
    unmountAll();
    useViewerStore.setState({ models: fakeFederation(1) });
    renderRibbonExports();
    const soloToast = await captureSuccessToast(async () => {
      await act(async () => {
        exportControl('json').click();
      });
    });
    assert.doesNotMatch(soloToast, /active model only/, 'a single-model export is not partial');
  });

  it('reports a partial federated CSV export from the real handler (#2511, #5874)', async () => {
    loadFakeModel();
    useViewerStore.setState({ models: fakeFederation(3) });
    const init = mock.method(GeometryProcessor.prototype, 'init', async () => undefined);
    const dispose = mock.method(GeometryProcessor.prototype, 'dispose', () => undefined);
    const exportCsv = mock.method(GeometryProcessor.prototype, 'exportCsv', () => new TextEncoder().encode('id\n1\n'));
    try {
      render(<CsvExportHarness />);
      const runCsv = exportEntitiesCsv;
      assert.ok(runCsv);
      const message = await captureSuccessToast(async () => {
        await act(async () => { await runCsv(); });
      });
      assert.match(message, /Exported entities CSV — active model only, 2 other loaded models not included/);
      assert.equal(exportCsv.mock.callCount(), 1, 'CSV passed through the real export handler');
    } finally {
      init.mock.restore();
      dispose.mock.restore();
      exportCsv.mock.restore();
    }
  });

  it('a dialog format opens its dialog from the ribbon', async () => {
    loadFakeModel();

    renderRibbonExports();
    await act(async () => {
      exportControl('ifc').click();
    });
    assert.ok(
      document.body.querySelector('[role="dialog"]'),
      'the ribbon IFC button must open the export dialog',
    );
  });
});
