/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Export parity between the two toolbar styles.
 *
 * The viewer ships the classic `MainToolbar` strip *and* the tabbed
 * `RibbonToolbar`; a user on either must reach the same export formats. This
 * file is the gate: it renders both styles' Export clusters and asserts each
 * emits exactly the ids in `EXPORT_COMMANDS`, in the same order — so adding a
 * format to one surface and not the other fails here.
 *
 * It also nails down the three ways someone could get around the registry:
 * hand-rolling an export entry inside a toolbar (source guard), adding a
 * registry entry without teaching a style's icon set about it (icon-set
 * coverage, checked for the ribbon by source because `@/icons` only resolves
 * through the Vite plugin), and — the one that bites hardest — deleting a
 * surface's Export cluster while leaving its import behind, which every other
 * test here happily survives because they render the cluster components
 * directly rather than the toolbars that host them.
 *
 * Presence is not enough — a wired-looking button whose handler does nothing
 * has shipped here before — so the last tests actually click through both
 * surfaces and assert a download is produced, the right one is produced, and a
 * dialog opens.
 */

import '@/test/setup-dom.js';
import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.js';
import { TooltipProvider } from '@/components/ui/tooltip.js';
import { useViewerStore } from '@/store/index.js';
// Bare specifiers, matching what the code under test imports: a `.js`-suffixed
// copy could resolve to a second module instance, and the toast spy would then
// watch an object nothing calls.
import { toast } from '@/components/ui/toast';
import type { FederatedModel } from '@/store/types';
import type { IfcDataStore } from '@ifc-lite/parser';
import { EVENT_FILE_DOWNLOADED } from '@/lib/tours/events.js';
import {
  EXPORT_COMMANDS,
  EXPORT_COMMAND_IDS,
  type ExportIconSet,
} from './export-commands.js';
import { CLASSIC_EXPORT_ICONS, ClassicExportMenuItems } from './ClassicExportMenuItems.js';
import { RibbonExportGroup } from '../ribbon/tabs/RibbonExportGroup.js';

const VIEWER_SRC = fileURLToPath(new URL('../../..', import.meta.url));

function readSource(relativePath: string): string {
  return readFileSync(`${VIEWER_SRC}/${relativePath}`, 'utf8');
}

/** Import statements (including multi-line named imports), matched as a unit. */
const IMPORT_STATEMENT =
  /^import\b[\s\S]*?from\s*['"][^'"]*['"];?[ \t]*$|^import\s+['"][^'"]*['"];?[ \t]*$/gm;

/**
 * The part of a module that actually *does* something. An import is not reach:
 * deleting `<ClassicExportMenuItems />` from `MainToolbar` while leaving the
 * import line behind is exactly the regression the surface test below exists to
 * catch, and matching against the whole file would let it through.
 */
function bodyWithoutImports(source: string): string {
  return source.replace(IMPORT_STATEMENT, '');
}

/** True when `name` is referenced somewhere other than an import statement. */
function usedOutsideImports(source: string, name: string): boolean {
  return new RegExp(`\\b${name}\\b`).test(bodyWithoutImports(source));
}

/**
 * The ribbon's real icons come from `@/icons`, which resolves through
 * `unplugin-icons` and cannot be loaded by the node test runner; the component
 * takes the set as a prop so it stays renderable here. The real set is covered
 * by `ribbon icon set covers every registered format` below.
 */
function StubIcon(props: React.SVGProps<SVGSVGElement>) {
  return <svg {...props} />;
}
const STUB_ICONS = Object.fromEntries(
  EXPORT_COMMAND_IDS.map((id) => [id, StubIcon]),
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

/** The classic strip's Export cluster: the body of its Download dropdown. */
function renderClassicExports(): void {
  render(
    <DropdownMenu open modal={false}>
      <DropdownMenuTrigger>Export and download</DropdownMenuTrigger>
      <DropdownMenuContent>
        <ClassicExportMenuItems />
      </DropdownMenuContent>
    </DropdownMenu>,
  );
}

/** The ribbon's Export cluster: the File tab's Export group. */
function renderRibbonExports(): void {
  render(<RibbonExportGroup icons={STUB_ICONS} />);
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
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

describe('export UI parity', () => {
  it('the registry is internally consistent', () => {
    const ids = EXPORT_COMMANDS.map((c) => c.id);
    assert.deepEqual([...EXPORT_COMMAND_IDS], ids, 'EXPORT_COMMAND_IDS must mirror the registry');
    assert.equal(new Set(ids).size, ids.length, 'export command ids must be unique');
    assert.ok(ids.length > 0, 'the registry must not be empty');
  });

  it('the classic toolbar renders every registered export format', () => {
    renderClassicExports();
    assert.deepEqual(renderedExportIds(), [...EXPORT_COMMAND_IDS]);
  });

  it('the ribbon renders every registered export format', () => {
    renderRibbonExports();
    assert.deepEqual(renderedExportIds(), [...EXPORT_COMMAND_IDS]);
  });

  it('both toolbar styles expose the same formats in the same order', () => {
    renderClassicExports();
    const classic = renderedExportIds();
    unmountAll();
    renderRibbonExports();
    const ribbon = renderedExportIds();

    assert.deepEqual(
      ribbon,
      classic,
      'a format reachable in one toolbar style must be reachable in the other — ' +
        'add it to EXPORT_COMMANDS instead of to a single toolbar',
    );
  });

  it('both toolbar styles gate every format identically', () => {
    // No model, no data store: everything is off in both styles.
    renderClassicExports();
    const classicOff = renderedExportIds().filter((id) => {
      const el = exportControl(id);
      return el.hasAttribute('disabled') || el.getAttribute('data-disabled') !== null;
    });
    unmountAll();
    renderRibbonExports();
    const ribbonOff = renderedExportIds().filter((id) => {
      const el = exportControl(id);
      return el.hasAttribute('disabled') || el.getAttribute('data-disabled') !== null;
    });

    assert.deepEqual(ribbonOff, classicOff);
    assert.deepEqual(ribbonOff, [...EXPORT_COMMAND_IDS], 'nothing is exportable with no model loaded');
  });

  it('the classic icon set covers every registered format', () => {
    assert.deepEqual(Object.keys(CLASSIC_EXPORT_ICONS).sort(), [...EXPORT_COMMAND_IDS].sort());
  });

  it('the ribbon icon set covers every registered format', () => {
    // Read as source: `@/icons` resolves only through the Vite plugin, so the
    // real map cannot be imported here. Its keys must still be exhaustive.
    const source = readSource('components/viewer/ribbon/tabs/ribbon-export-icons.ts');
    const body = source.slice(source.indexOf('RIBBON_EXPORT_ICONS'));
    const keys = [...body.matchAll(/^\s{2}([A-Za-z0-9_]+):/gm)].map((m) => m[1]);
    assert.deepEqual(keys.sort(), [...EXPORT_COMMAND_IDS].sort());
  });

  it('neither toolbar hand-rolls an export entry beside the registry', () => {
    const surfaces = [
      'components/viewer/MainToolbar.tsx',
      ...readdirSync(`${VIEWER_SRC}/components/viewer/ribbon/tabs`)
        .filter((f) => f.endsWith('.tsx') && f !== 'RibbonExportGroup.tsx')
        .map((f) => `components/viewer/ribbon/tabs/${f}`),
    ];

    for (const surface of surfaces) {
      const source = readSource(surface);
      assert.equal(
        /from ['"][^'"]*Export(Dialog|Modal)['"]/.test(source),
        false,
        `${surface} imports an export dialog directly — register the format in ` +
          'toolbar/export-commands.ts so both toolbar styles get it',
      );
      assert.equal(
        source.includes('data-export-command'),
        false,
        `${surface} renders an export control of its own — register the format in ` +
          'toolbar/export-commands.ts so both toolbar styles get it',
      );
      assert.equal(
        source.includes('useExportCommands'),
        false,
        `${surface} drives exports by hand — render ClassicExportMenuItems / ` +
          'RibbonExportGroup instead',
      );
    }
  });

  it('each toolbar style actually renders its export cluster', () => {
    // Every other test in this file renders ClassicExportMenuItems /
    // RibbonExportGroup itself, so it proves the clusters work — not that the
    // shipped toolbars still host them. Neither host can be rendered here
    // (MainToolbar drags in the whole viewer; FileTab reaches `@/icons`, a Vite
    // virtual module), so the host edge is checked in source, with imports
    // stripped so a leftover import line does not count as reach.
    const hosts = [
      {
        surface: 'components/viewer/MainToolbar.tsx',
        cluster: 'ClassicExportMenuItems',
        extras: [] as string[],
      },
      {
        surface: 'components/viewer/ribbon/tabs/FileTab.tsx',
        cluster: 'RibbonExportGroup',
        // The ribbon's real icon set only reaches the group through this prop;
        // it appears in FileTab's import line whether or not it is passed.
        extras: ['RIBBON_EXPORT_ICONS'],
      },
    ];

    for (const { surface, cluster, extras } of hosts) {
      const body = bodyWithoutImports(readSource(surface));
      assert.ok(
        body.length > 0,
        `${surface} has no body left after stripping imports — the import matcher is broken`,
      );
      assert.match(
        body,
        new RegExp(`<${cluster}[\\s/>]`),
        `${surface} must render <${cluster} /> — without it this toolbar style ships ` +
          'no exports at all, and every other test here still passes',
      );
      for (const extra of extras) {
        assert.ok(
          usedOutsideImports(readSource(surface), extra),
          `${surface} imports ${extra} but never uses it`,
        );
      }
    }
  });

  it('the JSON export actually downloads a file from both toolbar styles', async () => {
    loadFakeModel();

    renderClassicExports();
    const fromClassic = await captureDownloads(async () => {
      await act(async () => {
        exportControl('json').click();
      });
    });
    assert.deepEqual(fromClassic, ['json'], 'the classic JSON row must produce a download');

    unmountAll();

    renderRibbonExports();
    const fromRibbon = await captureDownloads(async () => {
      await act(async () => {
        exportControl('json').click();
      });
    });
    assert.deepEqual(fromRibbon, ['json'], 'the ribbon JSON button must produce a download');
  });

  it('the screenshot export saves a PNG from both toolbar styles', async () => {
    // The second `kind: 'action'` command, and the one that had already drifted
    // (the ribbon offered it with no model loaded). Asserting the *extension*
    // rather than "something downloaded" is what makes a cross-wired dispatch —
    // both action ids landing on the same handler — fail here.
    loadFakeModel();
    const canvas = document.createElement('canvas');
    canvas.toDataURL = () => 'data:image/png;base64,iVBORw0KGgo=';
    document.body.appendChild(canvas);

    try {
      renderClassicExports();
      const fromClassic = await captureDownloads(async () => {
        await act(async () => {
          exportControl('screenshot').click();
        });
      });
      assert.deepEqual(fromClassic, ['png'], 'the classic Screenshot row must save a PNG');

      unmountAll();

      renderRibbonExports();
      const fromRibbon = await captureDownloads(async () => {
        await act(async () => {
          exportControl('screenshot').click();
        });
      });
      assert.deepEqual(fromRibbon, ['png'], 'the ribbon Screenshot button must save a PNG');
    } finally {
      canvas.remove();
    }
  });

  it('both toolbar styles say so when a data export covers the active model only', async () => {
    // CSV/JSON read the one active `ifcDataStore`, so a federated session gets
    // a partial export. Spanning the federation changes the output contract and
    // is deliberately not done here — but a partial export must not be reported
    // as a whole one, in EITHER style, since both read the same hook.
    loadFakeModel();
    useViewerStore.setState({ models: fakeFederation(3) });

    renderClassicExports();
    const classicToast = await captureSuccessToast(async () => {
      await act(async () => {
        exportControl('json').click();
      });
    });
    assert.match(
      classicToast,
      /active model only, 2 other loaded models not included/,
      'the classic JSON row must not report a federated partial export as a whole one',
    );

    unmountAll();

    renderRibbonExports();
    const ribbonToast = await captureSuccessToast(async () => {
      await act(async () => {
        exportControl('json').click();
      });
    });
    assert.equal(
      ribbonToast,
      classicToast,
      'both styles read one hook, so they must describe the same export identically',
    );

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

  it('a dialog format opens its dialog from both toolbar styles', async () => {
    loadFakeModel();

    renderClassicExports();
    await act(async () => {
      exportControl('ifc').click();
    });
    assert.ok(
      document.body.querySelector('[role="dialog"]'),
      'the classic IFC row must open the export dialog',
    );

    unmountAll();

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
