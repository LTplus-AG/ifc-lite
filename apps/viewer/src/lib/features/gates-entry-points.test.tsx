/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A switched-off feature has no side door: entry points outside the palette,
 * ribbon and shortcuts that reached editing, export, files, samples, AI,
 * extensions, product links or outside services (review of the third gating PR).
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import type { MapConversion, ProjectedCRS } from '@ifc-lite/parser';
import { cleanup, render, waitFor } from '@/test/render';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { useViewerStore } from '@/store';
import { resetFeaturesForTest } from './index';
import { isSurfaceCommandAvailable, isAiChatAvailable } from '@/components/viewer/surface-command-features';
import { SURFACE_COMMANDS } from '@/components/viewer/surface-command-registry';
import { GeoreferencingPanel } from '@/components/viewer/properties/GeoreferencingPanel';
import { GeoreferenceTab } from '@/components/viewer/placement/GeoreferenceTab';
import { PositionedDownload } from '@/components/viewer/PositionedDownload';
import { PanelModelGate } from '@/components/viewer/PanelModelGate';
import { AboutTab } from '@/components/viewer/KeyboardShortcutsDialogTabs';
import { ShortcutsTab } from '@/components/viewer/ShortcutsTab';
import { SemanticProfileControls } from '@/components/viewer/SemanticProfileControls';
import { FlavorDialogHost } from '@/components/extensions/FlavorDialogHost';
import { useFileCommands, type FileCommands } from '@/components/viewer/toolbar/useFileCommands';
import { createExportAdapter } from '@/sdk/adapters/export-adapter';
import type { StoreApi } from '@/sdk/adapters/types';
import { isTourAvailable } from '@/lib/tours/tour-availability';
import { WELCOME_TOUR } from '@/lib/tours/tours/welcome';
import { loadDemoProject } from '@/lib/tours/demo-kit';
import { mainViewerTool } from '@/lib/agent-tools/main-viewer-dispatch';
import { mainViewerToolDefinitions } from '@/lib/agent-tools/main-viewer-tool-definitions';
import { openIfcFilesWithHandles } from '@/services/file-system-access';
import { KeyboardShortcutsDialog } from '@/components/viewer/KeyboardShortcutsDialog';
import { queryTerrainElevation, resolveProjection } from '@/lib/geo/reproject';
import { DEFAULT_PROFILE } from '@ifc-lite/semantic';

// Vite `define`s the About tab reads (see vite.config.ts).
Object.assign(globalThis, { __APP_VERSION__: '0.0.0-test', __BUILD_DATE__: '2026-01-01T00:00:00Z' });

const original = useViewerStore.getState();
afterEach(() => {
  cleanup();
  resetFeaturesForTest();
  useViewerStore.setState(original, true);
});

const MAP_CONVERSION: MapConversion = {
  id: 73, sourceCRS: 41, targetCRS: 71, eastings: 311_988.181, northings: 5_996_148.565,
  orthogonalHeight: 12, xAxisAbscissa: 1, xAxisOrdinate: 0, scale: 1,
};
const PROJECTED_CRS = { id: 71, name: 'EPSG:25833', mapUnitScale: 1 } as ProjectedCRS;

/** Counts, not elements: an assertion diff that inspects a DOM node runs out of memory. */
const buttonsNamed = (text: string) => [...document.querySelectorAll('button')].filter((button) => button.textContent?.includes(text)).length;

describe('georeferencing goes with editing', () => {
  /** Editable georef rows draw a pen; a read-only panel draws none. */
  function penCount(): number {
    const ui = render(<GeoreferencingPanel modelId="A" enableEditing schemaVersion="IFC4"
      georef={{ hasGeoreference: true, mapConversion: MAP_CONVERSION, projectedCRS: PROJECTED_CRS, source: 'mapConversion' }} />);
    const trigger = [...ui.querySelectorAll('button')].find((button) => button.textContent?.includes('Coordinate Operation'));
    assert.ok(trigger);
    act(() => { trigger.click(); });
    const pens = ui.querySelectorAll('svg.lucide-pen-line').length;
    cleanup();
    return pens;
  }

  it('the Properties georeferencing rows are read-only with edit.model or edit.placement off', () => {
    assert.ok(penCount() > 0, 'editable by default');
    resetFeaturesForTest({ default: 'all', disable: ['edit.model'] });
    assert.equal(penCount(), 0, 'edit.model off');
    resetFeaturesForTest({ default: 'all', disable: ['edit.placement'] });
    assert.equal(penCount(), 0, 'edit.placement off');
  });

  it('the Placement panel says editing is off instead of offering a switch that does nothing', async () => {
    resetFeaturesForTest({ default: 'all', disable: ['edit.model'] });
    useViewerStore.setState({ ...fixtureModels(fixtureModel('m')) });
    await resolveProjection(PROJECTED_CRS);
    const ui = render(<GeoreferenceTab modelId="m" mapConversion={MAP_CONVERSION} baseMapConversion={MAP_CONVERSION} projectedCRS={PROJECTED_CRS} />);
    await waitFor(() => /Editing is not available in this viewer/.test(ui.textContent ?? ''), 'switched-off notice');
    assert.equal(ui.querySelector('button[role="switch"]')?.hasAttribute('disabled') ?? null, true);
  });

  it('every command that needs the editor role goes with edit.model, so a new authoring tool cannot slip through', () => {
    resetFeaturesForTest({ default: 'all', disable: ['edit.model'] });
    const state = { canEditInSession: true, cesiumAvailable: true, collabEnabled: true };
    const ungated = SURFACE_COMMANDS.filter((command) =>
      command.enabled(state) && !command.enabled({ ...state, canEditInSession: false }) && isSurfaceCommandAvailable(command),
    ).map((command) => command.id);
    assert.deepEqual(ungated, []);
  });

  it('Move georeference is not offered without editing', () => {
    resetFeaturesForTest({ default: 'all', disable: ['edit.model'] });
    assert.equal(isSurfaceCommandAvailable({ id: 'view:move-georef' }), false);
    assert.equal(isSurfaceCommandAvailable({ id: 'model:reposition' }), true, 'repositioning a model is not an edit');
  });
});

describe('export off has no other door', () => {
  it('a script cannot download a file', () => {
    resetFeaturesForTest({ default: 'all', disable: ['export.files'] });
    const exporter = createExportAdapter(useViewerStore as unknown as StoreApi);
    assert.throws(() => exporter.download('a,b', 'out.csv', 'text/csv'), /Export is switched off/);
  });

  it('a point cloud row offers no positioned download', () => {
    useViewerStore.setState({ ...fixtureModels({ ...fixtureModel('pc'), pointCloudHandleId: 1 }) });
    assert.equal(render(<PositionedDownload modelId="pc" />).querySelectorAll('button').length, 1, 'offered by default');
    cleanup();
    resetFeaturesForTest({ default: 'all', disable: ['export.files'] });
    assert.equal(render(<PositionedDownload modelId="pc" />).querySelectorAll('button').length, 0);
  });
});

describe('files and samples off have no other door', () => {
  it('a tour, which loads the sample project, is not offered and the demo does not load', async () => {
    resetFeaturesForTest({ default: 'all', disable: ['files.samples'] });
    assert.equal(isTourAvailable(WELCOME_TOUR), false);
    await assert.rejects(loadDemoProject(), /Sample models are switched off/);
  });

  it('the learning hub goes with the tours it lists', () => {
    resetFeaturesForTest({ default: 'all', disable: ['files.samples'] });
    assert.equal(isSurfaceCommandAvailable({ id: 'learn:hub' }), false);
    render(<KeyboardShortcutsDialog open onClose={() => {}} initialTab="about" />);
    assert.equal([...document.querySelectorAll('[role="tab"]')].filter((tab) => tab.textContent?.includes('Learn')).length, 0);
  });

  it('no File System Access picker opens with local files off, whoever asks', async () => {
    resetFeaturesForTest({ default: 'all', disable: ['files.local'] });
    let pickers = 0;
    const win = window as unknown as { showOpenFilePicker?: () => Promise<never[]> };
    const saved = win.showOpenFilePicker;
    win.showOpenFilePicker = async () => { pickers++; return []; };
    try {
      assert.equal(await openIfcFilesWithHandles(), null);
      assert.equal(pickers, 0);
    } finally {
      win.showOpenFilePicker = saved;
    }
  });

  it('an empty panel offers neither the demo nor the file picker when both are off', () => {
    resetFeaturesForTest({ default: 'all', disable: ['files.samples', 'files.local'] });
    render(<PanelModelGate id="lens" mode="takeover" onClose={() => {}}><span /></PanelModelGate>);
    assert.equal(buttonsNamed('Load demo project'), 0);
    assert.equal(buttonsNamed('Open'), 0);
    assert.match(document.body.textContent ?? '', /from the page that brought you here/, 'says where the model comes from');
  });

  it('the open and add-model handlers do not show a picker with local files off', async () => {
    resetFeaturesForTest({ default: 'all', disable: ['files.local'] });
    let pickers = 0;
    const win = window as unknown as { showOpenFilePicker?: () => Promise<never[]> };
    const saved = win.showOpenFilePicker;
    win.showOpenFilePicker = async () => { pickers++; return []; };
    let commands: FileCommands | undefined;
    function Harness() { commands = useFileCommands(); return null; }
    try {
      render(<Harness />);
      assert.ok(commands);
      await commands.handleOpenClick();
      await commands.handleAddModelClick();
      assert.equal(pickers, 0);
    } finally {
      win.showOpenFilePicker = saved;
    }
  });
});

describe('AI and extensions off have no other door', () => {
  it('the AI chat needs the Script panel it lives in', () => {
    resetFeaturesForTest({ default: 'all', disable: ['automate.scripting'] });
    assert.equal(isAiChatAvailable(), false);
    resetFeaturesForTest({ default: 'all', disable: ['ai.assistant'] });
    assert.equal(isAiChatAvailable(), false);
    resetFeaturesForTest();
    assert.equal(isAiChatAvailable(), true);
  });

  it('a profile opened from a library does not open the flavor dialog', async () => {
    // Mounting the dialog here (no extension host) throws, so reaching it fails the test too.
    resetFeaturesForTest({ default: 'all', disable: ['automate.extensions'] });
    await import('@/components/extensions/FlavorDialog'); // so the lazy dialog would mount at once
    let thrown: unknown;
    const onError = (event: ErrorEvent) => { thrown = event.error; };
    window.addEventListener('error', onError);
    render(<FlavorDialogHost />);
    act(() => useViewerStore.getState().setFlavorDialogRequested(true));
    await new Promise((resolve) => setTimeout(resolve, 200));
    window.removeEventListener('error', onError);
    assert.equal(thrown, undefined);
    assert.equal(useViewerStore.getState().flavorDialogRequested, true, 'the request is left unanswered');
  });
});

describe('product links and outside services off have no other door', () => {
  it('the About and Shortcuts tabs link nowhere outside the viewer', () => {
    resetFeaturesForTest({ default: 'all', disable: ['help.product-links'] });
    render(<AboutTab />);
    render(<ShortcutsTab />);
    assert.deepEqual([...document.querySelectorAll('a[href^="https://"]')].map((a) => a.getAttribute('href')), []);
  });

  it('bSDD is offered neither in the semantic profile nor to the agent', () => {
    resetFeaturesForTest({ default: 'all', disable: ['privacy.third-party'] });
    render(<SemanticProfileControls profile={DEFAULT_PROFILE} onProfile={() => {}} onError={() => {}} />);
    assert.equal(buttonsNamed('Search bSDD'), 0);
    assert.equal(mainViewerTool('bsdd_search'), undefined);
    assert.equal(mainViewerToolDefinitions().filter((definition) => definition.name.startsWith('bsdd_')).length, 0, 'not offered to the model either');
    resetFeaturesForTest();
    assert.ok(mainViewerTool('bsdd_search'));
  });

  it('a missing projection or a terrain height is not fetched from an outside service', async () => {
    resetFeaturesForTest({ default: 'all', disable: ['privacy.third-party'] });
    const savedFetch = globalThis.fetch;
    const asked: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => { asked.push(String(input)); return new Response('', { status: 404 }); }) as typeof fetch;
    try {
      await resolveProjection({ id: 9, name: 'EPSG:999999' } as ProjectedCRS);
      assert.equal(await queryTerrainElevation({ lat: 47, lon: 8 }), null);
      assert.deepEqual(asked.filter((url) => /^https?:/.test(url)), []);
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  it('the 3D world context cannot be toggled on', () => {
    resetFeaturesForTest({ default: 'all', disable: ['privacy.third-party'] });
    useViewerStore.setState({ cesiumEnabled: false });
    useViewerStore.getState().toggleCesium();
    assert.equal(useViewerStore.getState().cesiumEnabled, false);
  });
});
