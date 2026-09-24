/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `resolveFlowContributions` (#5167 phase 4.2): a `contributes.flows`
 * entry is validated end-to-end (parse + wiring + capability bound), and
 * a bad graph is rejected by name without taking down the extension's
 * other graphs.
 */

import { BrowserTrackingStore } from '@/lib/flow/persistence';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { Bundle, BundleFile, ExtensionManifest, InstalledExtensionRecord } from '@ifc-lite/extensions';
import { NodeRegistry, type NodeDef } from '@ifc-lite/flow';
import {
  contributedFlowId,
  isContributedFlowId,
  forgetContributedFlowState,
  resolveFlowContributions,
  type ContributedFlow,
} from './host-flows.js';

const EXT_ID = 'com.example.flows';

/** One source node with a `model.read` capability requirement — enough to exercise wiring + capabilities. */
const registry = new NodeRegistry<unknown>().registerAll([
  {
    type: 'test.source',
    title: 'Source',
    category: 't',
    inputs: [],
    outputs: [{ name: 'value', type: { kind: 'scalar', access: 'item' } }],
    params: [],
    capabilities: [],
    run: () => ({ value: 1 }),
  },
] satisfies NodeDef<unknown>[]);

function goodGraph(id: string, capabilities: string[] = []): string {
  return JSON.stringify({
    flowVersion: 1,
    id,
    name: 'Placeholder — overwritten by the contribution name',
    capabilities,
    inputs: [],
    outputs: [{ nodeId: 'src', port: 'value', label: 'Value' }],
    nodes: [{ id: 'src', type: 'test.source' }],
    edges: [],
  });
}

function manifestWith(
  flows: Array<{ id: string; name: string; path: string }>,
): ExtensionManifest {
  return {
    manifestVersion: 1,
    id: EXT_ID,
    name: 'Demo Flow Extension',
    description: 'Fixture extension for host-flows tests.',
    version: '1.0.0',
    engines: { ifcLiteSdk: '>=1.0.0' },
    capabilities: ['model.read'],
    activation: ['onStartup'],
    entry: {},
    contributes: { flows },
  };
}

function bundleFile(path: string, text: string): BundleFile {
  return { path, bytes: new TextEncoder().encode(text), text };
}

function bundleWith(files: Record<string, string>, manifest: ExtensionManifest): Bundle {
  const map = new Map<string, BundleFile>();
  for (const [path, text] of Object.entries(files)) map.set(path, bundleFile(path, text));
  return { manifest, files: map, source: { kind: 'memory' } };
}

function installedRecord(overrides: Partial<InstalledExtensionRecord> = {}): InstalledExtensionRecord {
  return {
    id: EXT_ID,
    version: '1.0.0',
    bundleHash: 'deadbeef',
    grantedCapabilities: ['model.read'],
    enabled: true,
    installedAt: '2024-01-01T00:00:00.000Z',
    source: 'local',
    ...overrides,
  };
}

function loaderWith(bundle: Bundle | undefined) {
  return { getBundle: (id: string) => (id === EXT_ID ? bundle : undefined) };
}

describe('contributedFlowId / isContributedFlowId', () => {
  it('namespaces by extension id and is recognisable', () => {
    const id = contributedFlowId(EXT_ID, 'g1');
    assert.equal(id, `ext:${EXT_ID}:g1`);
    assert.equal(isContributedFlowId(id), true);
    assert.equal(isContributedFlowId(crypto.randomUUID()), false);
  });
});

describe('resolveFlowContributions', () => {
  it('resolves a valid graph, namespaced, named from the contribution, capability-bound', () => {
    const manifest = manifestWith([{ id: 'g1', name: 'Fire Rating Audit', path: 'flows/g1.flow.json' }]);
    const bundle = bundleWith({ 'flows/g1.flow.json': goodGraph('g1', ['model.read']) }, manifest);
    const { graphs, diagnostics }: { graphs: readonly ContributedFlow[]; diagnostics: readonly unknown[] } =
      resolveFlowContributions({ loader: loaderWith(bundle) }, [installedRecord()], registry);

    assert.deepEqual(diagnostics, []);
    assert.equal(graphs.length, 1);
    assert.equal(graphs[0].doc.id, contributedFlowId(EXT_ID, 'g1'));
    assert.equal(graphs[0].doc.name, 'Fire Rating Audit');
    assert.equal(graphs[0].extensionId, EXT_ID);
    assert.equal(graphs[0].extensionName, 'Demo Flow Extension');
  });

  it('rejects a graph with wiring problems, naming the extension and the graph, without touching a sibling graph', () => {
    const manifest = manifestWith([
      { id: 'broken', name: 'Broken', path: 'flows/broken.flow.json' },
      { id: 'ok', name: 'OK', path: 'flows/ok.flow.json' },
    ]);
    const brokenSource = JSON.stringify({
      flowVersion: 1,
      id: 'broken',
      name: 'Broken',
      capabilities: [],
      inputs: [],
      outputs: [{ nodeId: 'src', port: 'nope', label: 'Nope' }], // no such output
      nodes: [{ id: 'src', type: 'test.source' }],
      edges: [],
    });
    const bundle = bundleWith(
      { 'flows/broken.flow.json': brokenSource, 'flows/ok.flow.json': goodGraph('ok') },
      manifest,
    );
    const { graphs, diagnostics } = resolveFlowContributions({ loader: loaderWith(bundle) }, [installedRecord()], registry);

    assert.equal(graphs.length, 1, 'the sibling graph still loaded');
    assert.equal(graphs[0].graphId, 'ok');
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].extensionId, EXT_ID);
    assert.equal(diagnostics[0].graphId, 'broken');
    assert.match(diagnostics[0].message, /wiring/);
  });

  it('refuses every contribution sharing an id, rather than making one of them unreachable', () => {
    // Both would get the same namespaced id; the panel finds graphs by id, so
    // one could never be opened while the count still included it (#5431 review).
    const manifest = manifestWith([
      { id: 'same', name: 'First', path: 'flows/a.flow.json' },
      { id: 'same', name: 'Second', path: 'flows/b.flow.json' },
      { id: 'ok', name: 'OK', path: 'flows/ok.flow.json' },
    ]);
    const bundle = bundleWith(
      { 'flows/a.flow.json': goodGraph('a'), 'flows/b.flow.json': goodGraph('b'), 'flows/ok.flow.json': goodGraph('ok') },
      manifest,
    );
    const { graphs, diagnostics } = resolveFlowContributions({ loader: loaderWith(bundle) }, [installedRecord()], registry);

    assert.deepEqual(graphs.map((g) => g.graphId), ['ok']);
    assert.equal(diagnostics.length, 2);
    for (const d of diagnostics) {
      assert.equal(d.graphId, 'same');
      assert.match(d.message, /used by more than one flow contribution/);
    }
  });

  it('finds a graph whose manifest path has a leading ./, as the bundle loader accepts it', () => {
    // The loader normalises `./flows/x` to the bundle key `flows/x`; a raw
    // lookup reported the file missing (#5431 review).
    const manifest = manifestWith([{ id: 'dotted', name: 'Dotted', path: './flows/dotted.flow.json' }]);
    const bundle = bundleWith({ 'flows/dotted.flow.json': goodGraph('dotted') }, manifest);
    const { graphs, diagnostics } = resolveFlowContributions({ loader: loaderWith(bundle) }, [installedRecord()], registry);
    assert.deepEqual(diagnostics, []);
    assert.deepEqual(graphs.map((g) => g.graphId), ['dotted']);
  });

  it('rejects a graph that is not valid JSON / not a valid flow document', () => {
    const manifest = manifestWith([{ id: 'g1', name: 'G1', path: 'flows/g1.flow.json' }]);
    const bundle = bundleWith({ 'flows/g1.flow.json': '{not json' }, manifest);
    const { graphs, diagnostics } = resolveFlowContributions({ loader: loaderWith(bundle) }, [installedRecord()], registry);

    assert.equal(graphs.length, 0);
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].graphId, 'g1');
  });

  it('rejects a graph declaring a capability the extension was not granted', () => {
    const manifest = manifestWith([{ id: 'g1', name: 'G1', path: 'flows/g1.flow.json' }]);
    // The graph asks for model.mutate, but the install review only granted model.read.
    const bundle = bundleWith({ 'flows/g1.flow.json': goodGraph('g1', ['model.mutate']) }, manifest);
    const { graphs, diagnostics } = resolveFlowContributions(
      { loader: loaderWith(bundle) },
      [installedRecord({ grantedCapabilities: ['model.read'] })],
      registry,
    );

    assert.equal(graphs.length, 0);
    assert.equal(diagnostics.length, 1);
    assert.match(diagnostics[0].message, /not granted/);
  });

  it('accepts a graph declaring a capability the extension WAS granted', () => {
    const manifest = manifestWith([{ id: 'g1', name: 'G1', path: 'flows/g1.flow.json' }]);
    const bundle = bundleWith({ 'flows/g1.flow.json': goodGraph('g1', ['model.read']) }, manifest);
    const { graphs, diagnostics } = resolveFlowContributions(
      { loader: loaderWith(bundle) },
      [installedRecord({ grantedCapabilities: ['model.read'] })],
      registry,
    );
    assert.equal(diagnostics.length, 0);
    assert.equal(graphs.length, 1);
  });

  it('rejects a graph whose bundle file is missing', () => {
    const manifest = manifestWith([{ id: 'g1', name: 'G1', path: 'flows/missing.flow.json' }]);
    const bundle = bundleWith({}, manifest);
    const { graphs, diagnostics } = resolveFlowContributions({ loader: loaderWith(bundle) }, [installedRecord()], registry);
    assert.equal(graphs.length, 0);
    assert.match(diagnostics[0].message, /missing from the bundle/);
  });

  it('contributes nothing for a disabled extension', () => {
    const manifest = manifestWith([{ id: 'g1', name: 'G1', path: 'flows/g1.flow.json' }]);
    const bundle = bundleWith({ 'flows/g1.flow.json': goodGraph('g1') }, manifest);
    const { graphs } = resolveFlowContributions({ loader: loaderWith(bundle) }, [installedRecord({ enabled: false })], registry);
    assert.equal(graphs.length, 0);
  });

  it('contributes nothing when the bundle failed to load', () => {
    const { graphs } = resolveFlowContributions({ loader: loaderWith(undefined) }, [installedRecord()], registry);
    assert.equal(graphs.length, 0);
  });

  it('contributes nothing for an extension with no flows contribution', () => {
    const manifest = manifestWith([]);
    const bundle = bundleWith({}, manifest);
    const { graphs, diagnostics } = resolveFlowContributions({ loader: loaderWith(bundle) }, [installedRecord()], registry);
    assert.equal(graphs.length, 0);
    assert.equal(diagnostics.length, 0);
  });
});

describe('forgetContributedFlowState (#5431 review)', () => {
  it('clears the tracking sidecars of that extension\'s graphs only', () => {
    const store = new Map<string, string>();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        get length() { return store.size; },
        key: (i: number) => [...store.keys()][i] ?? null,
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => { store.set(k, v); },
        removeItem: (k: string) => { store.delete(k); },
      },
    });
    const mine = contributedFlowId(EXT_ID, 'check');
    const other = contributedFlowId('com.other', 'check');
    new BrowserTrackingStore(mine, 'content:x').save({ trackingKey: 'n', generation: 0, entries: {} });
    new BrowserTrackingStore(other, 'content:x').save({ trackingKey: 'n', generation: 0, entries: {} });
    assert.ok(BrowserTrackingStore.read(mine));

    forgetContributedFlowState(EXT_ID);

    assert.equal(BrowserTrackingStore.read(mine), undefined, 'a reinstall starts without the removed graph\'s tracking');
    assert.ok(BrowserTrackingStore.read(other), 'another extension\'s graphs keep theirs');
  });
});
