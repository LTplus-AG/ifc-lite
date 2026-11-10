/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The first commit of a populated store must not do whole-model work that no
 * visible row needs (NEW-4, load-time hillclimb).
 *
 * On a Holter load that commit took 848-910 ms before `setLoading(false)`:
 * the hierarchy built a row for every element (an IfcRelAggregates lookup
 * each) although every storey starts collapsed, and the status bar, its
 * viewport summary and the model metadata panel each walked the whole entity
 * index for the same physical-object set. The visible content is unchanged:
 * the same rows, counts and statistics.
 *
 * Real loader, parser, engine and panels over the real FZK fixture; the
 * counters wrap the loaded store's own relationship and type-index reads.
 */
import '@/test/setup-dom.js';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { useViewerStore } from '@/store';
import { SourceHostProvider } from '@/services/sources/SourceHostProvider';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ExtensionHostContext } from '@/sdk/ExtensionHostProvider.js';
import { ExtensionHostService } from '@/services/extensions/host.js';
import { createBimContext } from '@ifc-lite/sdk';
import { hook, skip } from '@/test/blank-ifc-loader-harness.js';
import { HierarchyPanel } from './HierarchyPanel';
import { StatusBar } from './StatusBar';
import { ModelMetadataPanel } from './properties/ModelMetadataPanel';

(globalThis as unknown as { __APP_VERSION__: string }).__APP_VERSION__ = '0.0.0-test';
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 600 });
Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 400 });
Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, value: 600 });
Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 400 });

const FIXTURE = new URL('../../../../../tests/models/ara3d/AC20-FZK-Haus.ifc', import.meta.url);
const fixtureSkip = skip || (existsSync(FIXTURE) ? false : 'Run pnpm fixtures for ara3d/AC20-FZK-Haus.ifc');

// The idle structure build is held and released by the test, not raced with a sleep.
type IdleGlobal = typeof globalThis & {
  requestIdleCallback?: (callback: () => void) => number;
  cancelIdleCallback?: (handle: number) => void;
};
const idleGlobal = globalThis as IdleGlobal;
let heldIdle: (() => void) | null = null;

function ActiveModelMetadata() {
  const model = useViewerStore((s) => (s.activeModelId ? s.models.get(s.activeModelId) : undefined));
  return model ? <ModelMetadataPanel model={model} /> : null;
}

const host = new ExtensionHostService({ sdk: createBimContext({ transport: {
  send: () => Promise.reject(new Error('SDK transport is not exercised by this test')),
  subscribe: () => () => {}, close: () => {},
} }) });

/** Visible text of each panel, for the before/after-idle comparison. */
function panelText(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[role="treeitem"]')].map((row) => row.textContent ?? '');
}

it('NEW-4: the populated-store commit does no per-element hierarchy work and one physical-object scan', { skip: fixtureSkip }, async () => {
  assert.ok(hook);
  const file = new File([readFileSync(FIXTURE)], 'AC20-FZK-Haus.ifc', { type: 'application/ifc' });
  await act(async () => { await hook!.loadFile(file, { kind: 'primary' }); });
  const loaded = useViewerStore.getState();
  const populated = { models: loaded.models, activeModelId: loaded.activeModelId,
    ifcDataStore: loaded.ifcDataStore, geometryResult: loaded.geometryResult };
  const store = loaded.ifcDataStore!;
  assert.ok(store, 'FZK parsed');

  // Start from an empty viewer with every panel mounted, as the load does.
  act(() => useViewerStore.setState({ models: new Map(), activeModelId: null, ifcDataStore: null, geometryResult: null }));
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(
    <ExtensionHostContext.Provider value={host}>
      <SourceHostProvider><TooltipProvider>
        <HierarchyPanel /><StatusBar /><ActiveModelMetadata />
      </TooltipProvider></SourceHostProvider>
    </ExtensionHostContext.Provider>,
  ));

  const realIdle = { request: idleGlobal.requestIdleCallback, cancel: idleGlobal.cancelIdleCallback };
  idleGlobal.requestIdleCallback = (callback) => { heldIdle = callback; return 1; };
  idleGlobal.cancelIdleCallback = () => { heldIdle = null; };
  let relatedCalls = 0, typeIndexScans = 0;
  const relationships = store.relationships;
  const getRelated = relationships.getRelated.bind(relationships);
  const byType = store.entityIndex.byType;
  const keys = byType.keys.bind(byType);
  relationships.getRelated = ((...args: Parameters<typeof getRelated>) => { relatedCalls++; return getRelated(...args); }) as typeof relationships.getRelated;
  byType.keys = (() => { typeIndexScans++; return keys(); }) as typeof byType.keys;
  const elementRows = [...store.spatialHierarchy?.byStorey.values() ?? []].reduce((sum, ids) => sum + ids.length, 0);
  try {
    act(() => useViewerStore.setState(populated));
    const visibleAtCommit = panelText(container);
    const commitRelated = relatedCalls;
    // Before this change: 96 lookups (one per contained element) and 3 scans.
    assert.ok(visibleAtCommit.length > 0, 'the hierarchy shows rows at the commit');
    assert.ok(commitRelated < elementRows / 4, `${commitRelated} relationship lookups for ${elementRows} contained elements: rows nobody can see were built`);
    assert.ok(typeIndexScans <= 1, `${typeIndexScans} whole-index physical-object scans in one commit`);

    // Deferred, not dropped: the complete structure (search, reveal, cheap
    // expansion) is built once the main thread is idle, and what the user
    // sees does not change when it lands.
    assert.ok(heldIdle, 'the structure build waits for idle');
    act(() => { const task = heldIdle; heldIdle = null; task?.(); });
    assert.ok(relatedCalls - commitRelated >= elementRows, 'the idle build visits every contained element');
    assert.deepEqual(panelText(container), visibleAtCommit, 'deferred structure changes no visible row');
  } finally {
    relationships.getRelated = getRelated;
    byType.keys = keys;
    idleGlobal.requestIdleCallback = realIdle.request;
    idleGlobal.cancelIdleCallback = realIdle.cancel;
    act(() => root.unmount());
    container.remove();
  }
});
