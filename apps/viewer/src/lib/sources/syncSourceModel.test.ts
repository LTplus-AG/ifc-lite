/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `syncSourceModel` re-downloads a cloud-source model in place. Unlike its
 * siblings in this directory (`loadQueue`, `persistence`) it shipped without
 * tests, and the properties below are the ones whose failure modes are
 * destructive rather than merely annoying:
 *
 * - **A failed fetch must not cost the user their model.** The function loads
 *   the replacement FIRST and only removes the old model on success; if
 *   `download` (or `addModel`) fails, the original must still be in the store
 *   afterwards. Reordering those two steps deletes a loaded model on any
 *   network blip.
 * - **A provider that no longer lists the file must say so**, rather than
 *   silently succeeding, downloading nothing, or walking a cursor chain
 *   forever.
 * - **The provider-supplied filename is sanitized** before it becomes a `File`
 *   — it is third-party data and reaches a download/export path — while the
 *   user's own model label survives the sync untouched.
 * - **The new revision id is carried onto the replacement model's source tag**,
 *   because that tag is what the next revision check compares against: leave
 *   the old id there and the model reports itself out of date forever.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type {
  FileSourceProvider,
  ListOptions,
  Page,
  PluginContext,
  PluginManifest,
  SourceFile,
  SourceTag,
} from '@ifc-lite/plugin-api';

class MemoryStorage implements Storage {
  private readonly map = new Map<string, string>();
  get length(): number { return this.map.size; }
  clear(): void { this.map.clear(); }
  getItem(key: string): string | null { return this.map.get(key) ?? null; }
  key(index: number): string | null { return [...this.map.keys()][index] ?? null; }
  removeItem(key: string): void { this.map.delete(key); }
  setItem(key: string, value: string): void { this.map.set(key, value); }
}

const localStorageMock = new MemoryStorage();
Object.defineProperty(globalThis, 'localStorage', {
  value: localStorageMock,
  configurable: true,
});

const { useViewerStore } = await import('@/store/index.js');
const { syncSourceModel, isSourceModelSyncing } = await import('./syncSourceModel.js');
type FederatedModel = import('@/store/types.js').FederatedModel;
type SourceHost = import('@/services/sources/source-host.js').SourceHost;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MODEL_ID = 'model-1';

function makeModel(overrides: Partial<FederatedModel> = {}): FederatedModel {
  return {
    id: MODEL_ID,
    // Deliberately NOT the source file's name: this is the user's own label,
    // which a sync must preserve.
    name: 'My renamed tower',
    ifcDataStore: null,
    geometryResult: null,
    visible: true,
    collapsed: false,
    schemaVersion: 'IFC4',
    loadedAt: 42,
    fileSize: 3,
    sourceFile: new File([new Uint8Array([1, 2, 3])], 'tower.ifc'),
    idOffset: 0,
    maxExpressId: 0,
    ...overrides,
  } as FederatedModel;
}

function makeFile(overrides: Partial<SourceFile> = {}): SourceFile {
  return {
    id: 'file-1',
    name: 'tower.ifc',
    containerId: 'container-1',
    currentRevisionId: 'rev-2',
    ...overrides,
  };
}

function makeTag(overrides: Partial<SourceTag> = {}): SourceTag {
  return {
    provider: 'test-provider',
    projectId: 'project-1',
    containerId: 'container-1',
    fileId: 'file-1',
    revisionId: 'rev-1',
    loadedAt: 1,
    ...overrides,
  };
}

const manifest = {
  name: 'test-provider',
  title: 'Test Provider',
  api: '^2.0.0',
  permissions: { network: [] },
  auth: 'preferences',
  preferences: [],
  capabilities: {
    containerListing: 'direct-children',
    listFilesIsRecursive: false,
    revisionHistory: false,
    downloadHistoricalRevisions: false,
    changeDetection: false,
    search: false,
  },
  contributes: { fileSources: [] },
} as PluginManifest;

interface ProviderStub {
  readonly pages?: ReadonlyArray<Page<SourceFile>>;
  readonly download?: () => Promise<ArrayBuffer>;
}

interface Harness {
  readonly sourceHost: SourceHost;
  readonly listCalls: Array<ListOptions | undefined>;
  readonly addModelCalls: Array<{ file: File; name?: string }>;
  readonly removed: string[];
  readonly addModel: (file: File, options?: { name?: string; modelId?: string }) => Promise<string | null>;
  readonly removeModel: (id: string) => void;
}

function makeHarness(stub: ProviderStub = {}, addModelImpl?: (file: File, options?: { modelId?: string }) => Promise<string | null>): Harness {
  const listCalls: Array<ListOptions | undefined> = [];
  const addModelCalls: Array<{ file: File; name?: string }> = [];
  const removed: string[] = [];
  const pages = stub.pages ?? [{ items: [makeFile()] }];

  const provider = {
    manifest,
    async listFiles(
      _ctx: PluginContext,
      _projectId: string,
      _containerId: string,
      _filter: unknown,
      options?: ListOptions,
    ): Promise<Page<SourceFile>> {
      listCalls.push(options);
      return pages[Math.min(listCalls.length - 1, pages.length - 1)];
    },
    download: stub.download ?? (async () => new Uint8Array([1, 2, 3]).buffer),
  } as unknown as FileSourceProvider;

  const sourceHost = {
    get: (name: string) => (name === manifest.name ? provider : undefined),
    createContext: () => ({}) as PluginContext,
    createSourceTag: (
      providerName: string,
      projectId: string,
      containerId: string,
      fileId: string,
      revisionId: string,
    ): SourceTag => ({
      provider: providerName,
      projectId,
      containerId,
      fileId,
      revisionId,
      loadedAt: 999,
    }),
  } as unknown as SourceHost;

  const addModel = async (file: File, options?: { name?: string; modelId?: string }) => {
    addModelCalls.push({ file, name: options?.name });
    if (addModelImpl) return addModelImpl(file, options);
    // Stand in for the real loader: register the replacement under the id the
    // caller allocated, which is what the post-add store check looks for.
    const id = options?.modelId ?? 'replacement';
    useViewerStore.setState((state) => {
      const models = new Map(state.models);
      models.set(id, makeModel({ id, name: options?.name ?? 'replacement' }));
      return { models };
    });
    return id;
  };

  const removeModel = (id: string) => {
    removed.push(id);
    useViewerStore.setState((state) => {
      const models = new Map(state.models);
      models.delete(id);
      return { models };
    });
  };

  return { sourceHost, listCalls, addModelCalls, removed, addModel, removeModel };
}

function seedStore(model = makeModel()): void {
  useViewerStore.setState({
    models: new Map([[model.id, model]]),
    activeModelId: model.id,
    sourceTags: new Map(),
    mutationViews: new Map(),
    selectedEntityIds: new Set(),
    selectedStoreys: new Set(),
    hiddenEntities: new Set(),
    isolatedEntities: null,
    ghostExceptEntities: null,
    classFilter: null,
    selectedEntities: [],
    selectedEntitiesSet: new Set(),
    selectedEntity: null,
    selectedEntityId: null,
    activeStorey: null,
    selectedModelId: null,
    hiddenEntitiesByModel: new Map(),
    isolatedEntitiesByModel: new Map(),
  });
}

beforeEach(() => {
  localStorageMock.clear();
  seedStore();
});

// ---------------------------------------------------------------------------

describe('syncSourceModel — a failed fetch never costs the user their model', () => {
  it('rejects with the provider error and leaves the original model loaded', async () => {
    const h = makeHarness({
      download: async () => {
        throw new Error('network is down');
      },
    });

    await assert.rejects(
      syncSourceModel({
        modelId: MODEL_ID,
        tag: makeTag(),
        sourceHost: h.sourceHost,
        addModel: h.addModel,
        removeModel: h.removeModel,
      }),
      /network is down/,
    );

    assert.ok(
      useViewerStore.getState().models.has(MODEL_ID),
      'the original model must survive a failed download',
    );
    assert.deepEqual(h.removed, [], 'nothing may be removed when the download fails');
    assert.deepEqual(h.addModelCalls, [], 'no replacement is loaded when the download fails');
  });

  it('rejects and keeps the original when the reload itself fails', async () => {
    const h = makeHarness({}, async () => null);

    await assert.rejects(
      syncSourceModel({
        modelId: MODEL_ID,
        tag: makeTag(),
        sourceHost: h.sourceHost,
        addModel: h.addModel,
        removeModel: h.removeModel,
      }),
      /Failed to reload tower\.ifc/,
    );

    assert.ok(
      useViewerStore.getState().models.has(MODEL_ID),
      'a failed reload must not delete the model it was replacing',
    );
    assert.deepEqual(h.removed, []);
  });

  it('clears the in-flight entry after a failure, so a retry is possible', async () => {
    const h = makeHarness({
      download: async () => {
        throw new Error('network is down');
      },
    });
    const promise = syncSourceModel({
      modelId: MODEL_ID,
      tag: makeTag(),
      sourceHost: h.sourceHost,
      addModel: h.addModel,
      removeModel: h.removeModel,
    });
    assert.equal(isSourceModelSyncing(MODEL_ID), true, 'a running sync must report as in flight');
    await assert.rejects(promise);
    assert.equal(isSourceModelSyncing(MODEL_ID), false);
  });
});

describe('syncSourceModel — the provider no longer offers the file', () => {
  it('reports the file as gone when the listing comes back empty', async () => {
    const h = makeHarness({ pages: [{ items: [] }] });

    await assert.rejects(
      syncSourceModel({
        modelId: MODEL_ID,
        tag: makeTag(),
        sourceHost: h.sourceHost,
        addModel: h.addModel,
        removeModel: h.removeModel,
      }),
      /no longer available in its original folder/,
    );
    assert.ok(useViewerStore.getState().models.has(MODEL_ID));
  });

  it('reports the file as gone when the listing has files but not this one', async () => {
    const h = makeHarness({ pages: [{ items: [makeFile({ id: 'some-other-file' })] }] });

    await assert.rejects(
      syncSourceModel({
        modelId: MODEL_ID,
        tag: makeTag(),
        sourceHost: h.sourceHost,
        addModel: h.addModel,
        removeModel: h.removeModel,
      }),
      /no longer available in its original folder/,
    );
  });

  it('follows the cursor across pages to find the file', async () => {
    const h = makeHarness({
      pages: [
        { items: [makeFile({ id: 'other' })], cursor: 'page-2' },
        { items: [makeFile()] },
      ],
    });

    const result = await syncSourceModel({
      modelId: MODEL_ID,
      tag: makeTag(),
      sourceHost: h.sourceHost,
      addModel: h.addModel,
      removeModel: h.removeModel,
    });

    assert.equal(result.latestFile.id, 'file-1');
    assert.equal(h.listCalls.length, 2);
    assert.equal(h.listCalls[0]?.cursor, undefined, 'the first page is requested without a cursor');
    assert.equal(h.listCalls[1]?.cursor, 'page-2', 'the second page uses the cursor the first returned');
  });

  it('stops instead of looping when a provider repeats the same cursor forever', async () => {
    const h = makeHarness({
      // Same cursor every time and never the wanted file: the shape a buggy or
      // hostile provider produces.
      pages: [{ items: [makeFile({ id: 'other' })], cursor: 'stuck' }],
    });

    await assert.rejects(
      syncSourceModel({
        modelId: MODEL_ID,
        tag: makeTag(),
        sourceHost: h.sourceHost,
        addModel: h.addModel,
        removeModel: h.removeModel,
      }),
      /no longer available in its original folder/,
    );
    assert.equal(
      h.listCalls.length,
      2,
      'a repeated cursor must be caught on the second page, not after 100',
    );
  });
});

describe('syncSourceModel — filename handling', () => {
  it('sanitizes the provider-supplied filename before it becomes a File', async () => {
    const h = makeHarness({
      pages: [{ items: [makeFile({ name: '../../etc/pas swd.ifc' })] }],
    });

    await syncSourceModel({
      modelId: MODEL_ID,
      tag: makeTag(),
      sourceHost: h.sourceHost,
      addModel: h.addModel,
      removeModel: h.removeModel,
    });

    const loaded = h.addModelCalls[0]?.file;
    assert.ok(loaded, 'a replacement File must be loaded');
    assert.doesNotMatch(loaded.name, /[/\\]/, 'no path separator may survive into the File name');
    assert.equal(loaded.name, 'etc-pas swd.ifc');
  });

  it('falls back to "model" when the provider name sanitizes away to nothing', async () => {
    const h = makeHarness({ pages: [{ items: [makeFile({ name: '///' })] }] });

    await syncSourceModel({
      modelId: MODEL_ID,
      tag: makeTag(),
      sourceHost: h.sourceHost,
      addModel: h.addModel,
      removeModel: h.removeModel,
    });

    assert.equal(h.addModelCalls[0]?.file.name, 'model');
  });

  it("keeps the user's model label rather than overwriting it with the source name", async () => {
    const h = makeHarness({ pages: [{ items: [makeFile({ name: 'tower-rev3.ifc' })] }] });

    await syncSourceModel({
      modelId: MODEL_ID,
      tag: makeTag(),
      sourceHost: h.sourceHost,
      addModel: h.addModel,
      removeModel: h.removeModel,
    });

    assert.equal(h.addModelCalls[0]?.name, 'My renamed tower');
  });
});

describe('syncSourceModel — the revision id lands on the replacement model', () => {
  it("writes the downloaded file's current revision id onto the new source tag", async () => {
    const h = makeHarness({
      pages: [{ items: [makeFile({ currentRevisionId: 'rev-7', containerId: 'moved-container' })] }],
    });

    const result = await syncSourceModel({
      modelId: MODEL_ID,
      tag: makeTag({ revisionId: 'rev-1' }),
      sourceHost: h.sourceHost,
      addModel: h.addModel,
      removeModel: h.removeModel,
    });

    assert.equal(result.sourceTag.revisionId, 'rev-7');
    // A file the provider reports in a different container must be tracked
    // there, not at the stale location the old tag recorded.
    assert.equal(result.sourceTag.containerId, 'moved-container');

    const stored = useViewerStore.getState().sourceTags.get(result.reloadedModelId);
    assert.ok(stored, 'the replacement model must carry a source tag');
    assert.equal(stored.revisionId, 'rev-7');
    assert.notEqual(
      result.reloadedModelId,
      MODEL_ID,
      'the replacement is loaded under a fresh id',
    );
  });

  it('swaps the old model out and makes the replacement active', async () => {
    const h = makeHarness();

    const result = await syncSourceModel({
      modelId: MODEL_ID,
      tag: makeTag(),
      sourceHost: h.sourceHost,
      addModel: h.addModel,
      removeModel: h.removeModel,
    });

    const state = useViewerStore.getState();
    assert.deepEqual(h.removed, [MODEL_ID], 'the old model is removed exactly once, after the load');
    assert.equal(state.models.has(MODEL_ID), false);
    assert.equal(state.models.has(result.reloadedModelId), true);
    assert.equal(state.activeModelId, result.reloadedModelId);
  });
});
