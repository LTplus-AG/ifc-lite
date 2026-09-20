/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Cloud Sources panel's own chrome reads the i18n catalogue (#4918
 * sweep, `sources.en.ts`): every heading, button label, tooltip,
 * aria-label, and status message written literally across the ten
 * `sources/` panel components.
 *
 * Same oracle shape as `MainToolbar.i18n.test.tsx` / `shared-commands.i18n
 * .test.tsx`: a pseudo-locale marks every `sources.*` key with `⟦key|…⟧`
 * (per plural category for the two plural keys), each component is
 * rendered in a state that surfaces as much of its own chrome as
 * possible, the locale is switched live, and the marked form of every key
 * exercised here must reappear. Unlike the toolbar oracles this file also
 * covers PARAMETERIZED keys (most of this panel's copy is a `{name}` /
 * `{title}` aria-label) — `expectedEnglish`/`expectedMarked` interpolate
 * the same catalogue templates the component's `t()` calls resolve, using
 * only param values this file's own fixtures chose, never runtime source
 * data.
 *
 * A handful of keys are converted in the component but not exercised
 * here, each for a stated reason (the same `NOT_RENDERED` convention the
 * toolbar oracles use for a ternary's other branch):
 *  - `sourcesPanel.noProviders` / `.unavailableProviders` / `.failedToRegister`:
 *    `registered-providers.ts` always registers three providers that never
 *    fail to construct — there is no supported way to render `SourcesPanel`
 *    with zero providers or a registration failure without mocking that
 *    module, which this suite (plain `node:test`, no module-mocking) cannot
 *    do.
 *  - `sourcesPanel.noProviderMessage` / `.connectionTestUnsupported`: both
 *    live inside `handleTestConnection`; the first needs `settingsProvider`
 *    to be `null` while its dialog is still open (the dialog only renders
 *    when a provider IS set), and the second needs a registered provider
 *    with no `testConnection` — all three real providers implement it.
 *  - the `sourcesPanel.revision*` messages / `.downloadFailedWithMessage` /
 *    `.downloadFailedGeneric`: reachable only through a background
 *    revision-watch effect and a real multi-file download loop, both deep
 *    async integrations with the source-tag/watch machinery that are out
 *    of scope for a chrome-localization oracle.
 */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import type {
  ConnectionTestResult,
  FileSourceProvider,
  Page,
  PluginContext,
  PluginManifest,
  SourceContainer,
  SourceFile,
  SourceIdentity,
  SourceProject,
} from '@ifc-lite/plugin-api';
import { render, cleanup } from '@/test/render.js';
import { registerLocale, setLocale, type Catalogue } from '@/i18n';
import { resolve } from '@/i18n/registry';
import type { PluralTranslation, TranslationValue } from '@/i18n/types';
import { sourcesEn } from '@/i18n/catalogues/sources.en';
import { SourceHost } from '@/services/sources/source-host';
import { SourceHostProvider } from '@/services/sources/SourceHostProvider';
import { SourceBrowserHeader } from './SourceBrowserHeader.js';
import { LoadMoreRow } from './SourceEntityList.js';
import { SourceFavouritesList } from './SourceFavouritesList.js';
import { SourceFileRow } from './SourceFileRow.js';
import { SourceFolderStep } from './SourceFolderStep.js';
import { SourceFolderTree } from './SourceFolderTree.js';
import { SourceProjectsStep } from './SourceProjectsStep.js';
import { SourceProviderRow } from './SourceProviderRow.js';
import { SourceSettingsDialog } from './SourceSettingsDialog.js';
import { RegistrationFailureMessage, SourcesPanel } from './SourcesPanel.js';
import { saveFavourites, type SourceFavourite } from '@/lib/sources/favourites';
import { syncSourceCatalogCacheOwner } from '@/lib/sources/persistence';

// ── Pseudo-locale plumbing ──

type SourcesKey = keyof typeof sourcesEn;

function interp(template: string, params: Record<string, string | number> = {}): string {
  return template.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (placeholder, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : placeholder,
  );
}

function pluralCategory(value: PluralTranslation, count: number): 'one' | 'other' {
  return count === 1 && value.one !== undefined ? 'one' : 'other';
}

/** English text a real `t(key, params)` call resolves to, computed the same
 *  way `resolve()` does: pick the plural category from `params.count`, then
 *  interpolate. */
function expectedEnglish(key: SourcesKey, params: Record<string, string | number> = {}): string {
  const value: TranslationValue = sourcesEn[key];
  const template = typeof value === 'string' ? value : value[pluralCategory(value, Number(params.count ?? 0))] ?? value.other;
  return interp(template, params);
}

function markValue(key: string, value: TranslationValue): TranslationValue {
  if (typeof value === 'string') return `⟦${key}|${value}⟧`;
  const marked: Record<string, string> = {};
  for (const [category, text] of Object.entries(value)) marked[category] = `⟦${key}.${category}|${text}⟧`;
  return marked as unknown as PluralTranslation;
}

/** Marked text the pseudo-locale produces for the same key/params. */
function expectedMarked(key: SourcesKey, params: Record<string, string | number> = {}): string {
  const value: TranslationValue = sourcesEn[key];
  if (typeof value === 'string') return interp(`⟦${key}|${value}⟧`, params);
  const category = pluralCategory(value, Number(params.count ?? 0));
  const text = value[category] ?? value.other;
  return interp(`⟦${key}.${category}|${text}⟧`, params);
}

const PSEUDO: Catalogue = Object.fromEntries(
  Object.entries(sourcesEn).map(([key, value]) => [key, markValue(key, value)]),
);
registerLocale('sources-pseudo', PSEUDO);

/** aria-label, title, and placeholder attributes, plus own text nodes —
 *  everything a user (or a translator checking a screenshot) can read.
 *  Radix portals (Dialog/Select) land on `document.body`, so this always
 *  reads from there rather than the mount container. */
function readableStrings(): Set<string> {
  const out = new Set<string>();
  document.body.querySelectorAll('*').forEach((element) => {
    for (const attr of ['aria-label', 'title', 'placeholder']) {
      const value = element.getAttribute(attr);
      if (value) out.add(value);
    }
    const ownText = [...element.childNodes]
      .filter((node) => node.nodeType === node.TEXT_NODE)
      .map((node) => node.textContent ?? '')
      .join('')
      .trim();
    if (ownText) out.add(ownText);
  });
  return out;
}

/** Asserts every `[key, params]` pair's English form is on screen, switches
 *  to the pseudo-locale, and asserts every marked form reappears. */
function assertLocalized(pairs: ReadonlyArray<readonly [SourcesKey, Record<string, string | number>?]>): void {
  const english = readableStrings();
  for (const [key, params] of pairs) {
    const text = expectedEnglish(key, params);
    assert.ok(english.has(text), `${key}: English "${text}" not found on screen`);
  }

  act(() => setLocale('sources-pseudo'));
  const marked = readableStrings();
  for (const [key, params] of pairs) {
    const text = expectedMarked(key, params);
    assert.ok(marked.has(text), `${key}: marked "${text}" not found after switching locale`);
  }
}

beforeEach(() => {
  setLocale('en');
});

afterEach(() => {
  cleanup();
  setLocale('en');
});

// ── Fixtures shared across sections ──

const CTX: PluginContext = {
  fetch: (() => Promise.reject(new Error('not exercised'))) as typeof fetch,
  fetchPublic: () => Promise.reject(new Error('not exercised')),
  getPreference: () => Promise.resolve(undefined),
  storage: {
    get: () => Promise.resolve(undefined),
    set: () => Promise.resolve(),
    delete: () => Promise.resolve(),
    keys: () => Promise.resolve([]),
  },
  log: { debug() {}, info() {}, warn() {}, error() {} },
};

function makeManifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    name: 'fixture-provider',
    title: 'Fixture Provider',
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
    ...overrides,
  };
}

async function pump(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

// ── SourceBrowserHeader ──

describe('SourceBrowserHeader localization', () => {
  it('translates the back button, sync button, and interpolated "synced ... ago" text', () => {
    const project: SourceProject = { id: 'proj-1', name: 'Tower Project' };
    const fileArea: SourceContainer = { id: 'area-1', name: 'Documents' };
    render(
      <SourceBrowserHeader
        step="folders"
        providerTitle="Fixture Provider"
        selectedProject={project}
        selectedFileArea={fileArea}
        catalogUpdatedAt={Date.now() - 90 * 60_000}
        syncing={false}
        busy={false}
        onBack={() => {}}
        onSync={() => {}}
      />,
    );

    assertLocalized([
      ['sources.sourceBrowserHeader.backAria'],
      ['sources.sourceBrowserHeader.sync'],
    ]);

    // `syncedAt`'s `{time}` is itself the output of another `t()` call
    // (`syncedHoursAgo`), so under the pseudo-locale it nests one marker
    // inside the other — asserted directly rather than through
    // `assertLocalized`'s single-level param model.
    assert.ok(
      readableStrings().has(
        expectedMarked('sources.sourceBrowserHeader.syncedAt', {
          time: expectedMarked('sources.sourceBrowserHeader.syncedHoursAgo', { count: 1 }),
        }),
      ),
      'syncedAt must nest the translated syncedHoursAgo text',
    );
  });

  it('selects singular and plural minute and hour messages (#5000 review)', () => {
    registerLocale('sources-sync-plurals', {
      'sources.sourceBrowserHeader.syncedMinutesAgo': { one: 'one minute', other: '{count} minutes' },
      'sources.sourceBrowserHeader.syncedHoursAgo': { one: 'one hour', other: '{count} hours' },
    });
    act(() => setLocale('sources-sync-plurals'));
    const now = Date.now();
    const cases = [[now - 60_000, 'one minute'], [now - 120_000, '2 minutes'], [now - 3_600_000, 'one hour'], [now - 7_200_000, '2 hours']] as const;
    for (const [catalogUpdatedAt, expected] of cases) {
      cleanup();
      render(<SourceBrowserHeader step="folders" providerTitle="Provider" selectedProject={{ id: 'p', name: 'Project' }} selectedFileArea={{ id: 'a', name: 'Area' }} catalogUpdatedAt={catalogUpdatedAt} syncing={false} busy={false} onBack={() => {}} onSync={() => {}} />);
      assert.ok(document.body.textContent?.includes(expected), `expected sync age "${expected}"`);
    }
  });
});

// ── SourceEntityList / LoadMoreRow ──

describe('SourceEntityList (LoadMoreRow) localization', () => {
  it('translates the loading label', () => {
    render(<LoadMoreRow hasMore loading onLoadMore={() => {}} label="unused while loading" />);
    assertLocalized([['sources.sourceEntityList.loading']]);
  });
});

// ── SourceFavouritesList ──

describe('SourceFavouritesList localization', () => {
  it('translates the heading, the two disabled reasons, and the remove aria-label', () => {
    const host = new SourceHost();
    // A provider this build still registers, but with an unmet required
    // preference — the "add the required settings" branch.
    host.register({
      manifest: makeManifest({
        name: 'unconfigured-provider',
        title: 'Unconfigured Provider',
        preferences: [{ name: 'apiKey', title: 'API key', type: 'password', required: true }],
      }),
      listProjects: () => Promise.resolve({ items: [] }),
      listContainers: () => Promise.resolve({ items: [] }),
      listFiles: () => Promise.resolve({ items: [] }),
      download: () => Promise.reject(new Error('not exercised')),
    } as unknown as FileSourceProvider);

    saveFavourites('unconfigured-provider', [
      favourite({ providerId: 'unconfigured-provider', containerName: 'Models', identityId: null }),
    ]);
    // A provider this build no longer registers at all — the "provider
    // unavailable" branch. Its cache-owner stamp is what `visibleOwner`
    // reads when the provider is absent from the host.
    syncSourceCatalogCacheOwner('gone-provider', null);
    saveFavourites('gone-provider', [
      favourite({ providerId: 'gone-provider', containerName: 'Archive', identityId: null }),
    ]);
    // A normal, enabled favourite — the remove aria-label.
    host.register({
      manifest: makeManifest({ name: 'ready-provider', title: 'Ready Provider' }),
      listProjects: () => Promise.resolve({ items: [] }),
      listContainers: () => Promise.resolve({ items: [] }),
      listFiles: () => Promise.resolve({ items: [] }),
      download: () => Promise.reject(new Error('not exercised')),
    } as unknown as FileSourceProvider);
    saveFavourites('ready-provider', [
      favourite({
        providerId: 'ready-provider',
        kind: 'file',
        fileId: 'file-1',
        fileName: 'Tower.ifc',
        identityId: null,
      }),
    ]);

    render(
      <SourceFavouritesList
        sourceHost={host}
        favouritesVersion={0}
        liveIdentities={new Map([['ready-provider', null]])}
        onOpen={() => {}}
        onChanged={() => {}}
      />,
    );

    assertLocalized([
      ['sources.sourceFavouritesList.heading'],
      ['sources.sourceFavouritesList.providerUnavailable'],
      ['sources.sourceFavouritesList.addRequiredSettings'],
      ['sources.sourceFavouritesList.removeFavouriteAria', { name: 'Tower.ifc' }],
    ]);
  });
});

function favourite(overrides: Partial<SourceFavourite> = {}): SourceFavourite {
  return {
    providerId: 'fixture-provider',
    kind: 'folder',
    projectId: 'project-1',
    projectName: 'Tower Project',
    fileAreaId: 'area-1',
    fileAreaName: 'Documents',
    containerId: 'folder-1',
    containerName: 'Models',
    identityId: null,
    addedAt: 1_000,
    ...overrides,
  };
}

// ── SourceFileRow ──

describe('SourceFileRow localization', () => {
  const file: SourceFile = {
    id: 'file-1',
    name: 'Tower.ifc',
    containerId: 'folder-1',
    currentRevisionId: 'rev-1',
  };

  it('translates the unselected/favourited/loaded/update-available state', () => {
    render(
      <ul>
        <SourceFileRow
          file={file}
          selected={false}
          onToggle={() => {}}
          loadedModelNames={['Tower.ifc']}
          syncingFile={false}
          onSyncLoadedFile={() => {}}
          downloadedStatus="update-available"
          favourited={true}
          onToggleFavourite={() => {}}
        />
      </ul>,
    );

    assertLocalized([
      ['sources.sourceFileRow.selectAria', { name: 'Tower.ifc' }],
      ['sources.sourceFileRow.updateAvailable'],
      ['sources.sourceFileRow.removeFavouriteAria', { name: 'Tower.ifc' }],
      ['sources.sourceFileRow.loadedTooltip', { names: 'Tower.ifc' }],
      ['sources.sourceFileRow.loadedBadge', { count: 1 }],
      ['sources.sourceFileRow.syncAria', { name: 'Tower.ifc' }],
    ]);
  });

  it('translates the selected/unfavourited/no-loaded state', () => {
    render(
      <ul>
        <SourceFileRow
          file={file}
          selected={true}
          onToggle={() => {}}
          loadedModelNames={[]}
          syncingFile={false}
          onSyncLoadedFile={() => {}}
          downloadedStatus="never-loaded"
          favourited={false}
          onToggleFavourite={() => {}}
        />
      </ul>,
    );

    assertLocalized([
      ['sources.sourceFileRow.deselectAria', { name: 'Tower.ifc' }],
      ['sources.sourceFileRow.addFavouriteAria', { name: 'Tower.ifc' }],
    ]);
  });
});

// ── SourceFolderTree ──

describe('SourceFolderTree localization', () => {
  it('translates "no subfolders"', () => {
    render(<SourceFolderTree containers={[]} rootId="area-1" onSelect={() => {}} />);
    assertLocalized([['sources.sourceFolderTree.noSubfolders']]);
  });

  it('translates the collapsed expand aria-label', () => {
    const folder: SourceContainer = { id: 'folder-1', name: 'Models', parentId: 'area-1' };
    const child: SourceContainer = { id: 'folder-2', name: 'Archive', parentId: 'folder-1' };
    render(<SourceFolderTree containers={[folder, child]} rootId="area-1" onSelect={() => {}} />);
    assertLocalized([['sources.sourceFolderTree.expandFolderAria']]);
  });

  it('translates the favourite aria-labels', () => {
    // Both siblings at depth 0: `SourceFolderTree` only passes
    // `isFavourite`/`onToggleFavourite` into its own top-level `tree.map`,
    // not into `TreeRow`'s recursive call for a node's children (a
    // pre-existing gap, not one this conversion introduced) — so a nested
    // folder never renders a favourite toggle at all. Two root-level
    // folders keep both branches (favourited / not) actually on screen.
    const models: SourceContainer = { id: 'folder-1', name: 'Models', parentId: 'area-1' };
    const archive: SourceContainer = { id: 'folder-2', name: 'Archive', parentId: 'area-1' };
    render(
      <SourceFolderTree
        containers={[models, archive]}
        rootId="area-1"
        onSelect={() => {}}
        isFavourite={(id) => id === 'folder-2'}
        onToggleFavourite={() => {}}
      />,
    );

    assertLocalized([
      ['sources.sourceFolderTree.addFavouriteAria', { name: 'Models' }],
      ['sources.sourceFolderTree.removeFavouriteAria', { name: 'Archive' }],
    ]);
  });
});

// ── SourceFolderStep ──

describe('SourceFolderStep localization', () => {
  const fileArea: SourceContainer = { id: 'area-1', name: 'Documents' };
  const folder: SourceContainer = { id: 'folder-1', name: 'Models', parentId: 'area-1' };
  const project: SourceProject = { id: 'proj-1', name: 'Tower Project' };
  const file: SourceFile = { id: 'file-1', name: 'Tower.ifc', containerId: 'area-1', currentRevisionId: 'rev-1' };

  function baseProps() {
    return {
      providerName: 'fixture-provider',
      selectedProject: project,
      selectedFileArea: fileArea,
      selectedContainer: fileArea,
      onSelectContainer: () => {},
      sortedFolders: [folder] as SourceContainer[],
      allFiles: [file],
      gateEmptyFolders: false,
      loadingFolders: false,
      loadingFiles: false,
      busy: false,
      downloadedRecords: new Map(),
      loadedModelNamesByFileId: new Map(),
      syncingFileIds: new Set<string>(),
      onSyncLoadedFile: () => {},
      onLoad: () => {},
      foldersHaveMore: true,
      onLoadMoreFolders: () => {},
      onLoadMoreFiles: () => {},
      loadingMore: false,
      searchEnabled: true,
      onSearchQueryChange: () => {},
      onSearchSubmit: () => {},
      onSearchClear: () => {},
      isFolderFavourite: () => false,
      onToggleFolderFavourite: () => {},
      isFileFavourite: () => false,
      onToggleFileFavourite: () => {},
    };
  }

  it('translates search chrome, subfolders, load-more rows, and the empty state (not searching)', () => {
    render(
      <SourceFolderStep
        {...baseProps()}
        sortedFiles={[]}
        selectedFiles={new Map()}
        onToggleFile={() => {}}
        filesHaveMore={true}
        searchQuery=""
        searchActive={false}
      />,
    );

    assertLocalized([
      ['sources.sourceFolderStep.searchPlaceholder'],
      ['sources.sourceFolderStep.searchAriaLabel'],
      ['sources.sourceFolderStep.subfoldersHeading'],
      ['sources.sourceFolderStep.noFilesFound'],
      ['sources.sourceFolderStep.loadMoreFolders'],
      ['sources.sourceFolderStep.loadMoreFiles'],
      ['sources.sourceFolderStep.fileAreaAddFavouriteAria', { name: 'Documents' }],
    ]);
  });

  it('translates the active-search chrome and the no-results message', () => {
    render(
      <SourceFolderStep
        {...baseProps()}
        sortedFiles={[]}
        selectedFiles={new Map()}
        onToggleFile={() => {}}
        filesHaveMore={false}
        searchQuery="tower"
        searchActive={true}
      />,
    );

    assertLocalized([
      ['sources.sourceFolderStep.clearSearchAria'],
      ['sources.sourceFolderStep.searchActiveHint'],
      ['sources.sourceFolderStep.noSearchResults'],
    ]);
  });

  it('translates the load-federated-model button, busy and idle', () => {
    render(
      <SourceFolderStep
        {...baseProps()}
        sortedFiles={[file]}
        selectedFiles={new Map([[file.id, file]])}
        onToggleFile={() => {}}
        filesHaveMore={false}
        searchQuery=""
        searchActive={false}
        busy={false}
      />,
    );
    assertLocalized([['sources.sourceFolderStep.loadButton', { count: 1 }]]);

    cleanup();
    setLocale('en');
    render(
      <SourceFolderStep
        {...baseProps()}
        sortedFiles={[file]}
        selectedFiles={new Map([[file.id, file]])}
        onToggleFile={() => {}}
        filesHaveMore={false}
        searchQuery=""
        searchActive={false}
        busy={true}
      />,
    );
    assertLocalized([['sources.sourceFolderStep.loadButtonBusy']]);
  });
});

// ── SourceProjectsStep ──

class ListProjectsFixtureProvider implements Pick<FileSourceProvider, 'manifest' | 'listProjects'> {
  constructor(
    readonly manifest: PluginManifest,
    private readonly page: Page<SourceProject>,
  ) {}
  listProjects(): Promise<Page<SourceProject>> {
    return Promise.resolve(this.page);
  }
}

describe('SourceProjectsStep localization', () => {
  it('translates the discoverable-only search chrome, hint, and empty state', async () => {
    const provider = new ListProjectsFixtureProvider(
      makeManifest({ capabilities: { ...makeManifest().capabilities, projectsAreDiscoverableOnly: true } }),
      { items: [] },
    );
    render(
      <SourceProjectsStep
        provider={provider as unknown as FileSourceProvider}
        ctx={CTX}
        onError={() => {}}
        onSelect={() => {}}
      />,
    );
    await pump();

    assertLocalized([
      ['sources.sourceProjectsStep.searchPlaceholder'],
      ['sources.sourceProjectsStep.searchAriaLabel'],
      ['sources.sourceProjectsStep.discoverableHint'],
      ['sources.sourceProjectsStep.emptyDiscoverable'],
    ]);
  });

  it('translates the default empty state and the load-more row', async () => {
    const provider = new ListProjectsFixtureProvider(makeManifest(), {
      items: [{ id: 'p1', name: 'Tower Project' }],
      cursor: 'next-page',
    });
    render(
      <SourceProjectsStep
        provider={provider as unknown as FileSourceProvider}
        ctx={CTX}
        onError={() => {}}
        onSelect={() => {}}
      />,
    );
    await pump();

    assertLocalized([['sources.sourceProjectsStep.loadMoreProjects']]);

    // A second, empty-results provider for the non-discoverable empty state.
    cleanup();
    setLocale('en');
    const empty = new ListProjectsFixtureProvider(makeManifest(), { items: [] });
    render(
      <SourceProjectsStep
        provider={empty as unknown as FileSourceProvider}
        ctx={CTX}
        onError={() => {}}
        onSelect={() => {}}
      />,
    );
    await pump();
    assertLocalized([['sources.sourceProjectsStep.emptyDefault']]);
  });
});

// ── SourceProviderRow ──

class AuthProviderFixture implements FileSourceProvider {
  readonly manifest: PluginManifest;
  private release: ((identity: SourceIdentity | null) => void) | null = null;
  private rejectRestore: ((reason: unknown) => void) | null = null;

  constructor(title: string, opts: { requiredMissing?: boolean } = {}) {
    this.manifest = makeManifest({
      name: title.toLowerCase().replace(/\s+/g, '-'),
      title,
      auth: 'interactive',
      preferences: opts.requiredMissing
        ? [{ name: 'clientId', title: 'Client ID', type: 'textfield', required: true }]
        : [],
    });
  }

  readonly auth = {
    restore: (): Promise<SourceIdentity | null> =>
      new Promise((resolve, reject) => {
        this.release = resolve;
        this.rejectRestore = reject;
      }),
    signIn: (): Promise<SourceIdentity> => Promise.reject(new Error('not exercised')),
    signOut: (): Promise<void> => Promise.resolve(),
    getIdentity: (): Promise<SourceIdentity | null> => Promise.resolve(null),
  };

  settle(identity: SourceIdentity | null): void {
    this.release?.(identity);
  }

  failRestore(reason: unknown): void {
    this.rejectRestore?.(reason);
  }

  listProjects(): Promise<Page<SourceProject>> {
    return Promise.resolve({ items: [] });
  }
  listContainers(): Promise<Page<SourceContainer>> {
    return Promise.resolve({ items: [] });
  }
  listFiles(): Promise<Page<SourceFile>> {
    return Promise.resolve({ items: [] });
  }
  download(): Promise<ArrayBuffer> {
    return Promise.reject(new Error('not exercised'));
  }
}

describe('SourceProviderRow localization', () => {
  it('translates the restoring-session hint before auth settles', () => {
    const provider = new AuthProviderFixture('Restoring Provider');
    render(
      <SourceProviderRow provider={provider} sourceHost={new SourceHost()} prefsVersion={0} onOpenSettings={() => {}} onBrowse={() => {}} />,
    );
    assertLocalized([['sources.sourceProviderRow.restoringSession']]);
  });

  it('translates settings/browse aria-labels and the sign-in state once restore settles signed-out', async () => {
    const provider = new AuthProviderFixture('Signed Out Provider');
    render(
      <SourceProviderRow provider={provider} sourceHost={new SourceHost()} prefsVersion={0} onOpenSettings={() => {}} onBrowse={() => {}} />,
    );
    await act(async () => { provider.settle(null); await Promise.resolve(); });
    await pump();

    assertLocalized([
      ['sources.sourceProviderRow.settingsAria', { title: 'Signed Out Provider' }],
      ['sources.sourceProviderRow.browseAria', { title: 'Signed Out Provider' }],
      ['sources.sourceProviderRow.signInAria', { title: 'Signed Out Provider' }],
      ['sources.sourceProviderRow.signIn'],
      ['sources.sourceProviderRow.signInToBrowse'],
    ]);
  });

  it('translates an expired-session notice live after the async restore fails', async () => {
    const provider = new AuthProviderFixture('Expired Provider');
    render(
      <SourceProviderRow provider={provider} sourceHost={new SourceHost()} prefsVersion={0} onOpenSettings={() => {}} onBrowse={() => {}} />,
    );
    await act(async () => { provider.failRestore(new Error('provider diagnostic')); await Promise.resolve(); });
    await pump();

    assertLocalized([['sources.sourceProviderRow.sessionExpired']]);
  });

  it('translates the sign-out button once restore settles signed-in', async () => {
    const provider = new AuthProviderFixture('Signed In Provider');
    render(
      <SourceProviderRow provider={provider} sourceHost={new SourceHost()} prefsVersion={0} onOpenSettings={() => {}} onBrowse={() => {}} />,
    );
    await act(async () => { provider.settle({ id: 'user-a' }); await Promise.resolve(); });
    await pump();

    assertLocalized([
      ['sources.sourceProviderRow.signOutAria', { title: 'Signed In Provider' }],
      ['sources.sourceProviderRow.signOut'],
    ]);
  });

  it('translates the two "add required settings" hints', async () => {
    // Interactive, but missing a required preference: "…, then sign in".
    const interactive = new AuthProviderFixture('Needs Settings Provider', { requiredMissing: true });
    render(
      <SourceProviderRow provider={interactive} sourceHost={new SourceHost()} prefsVersion={0} onOpenSettings={() => {}} onBrowse={() => {}} />,
    );
    await act(async () => { interactive.settle(null); await Promise.resolve(); });
    await pump();
    assertLocalized([['sources.sourceProviderRow.addSettingsThenSignIn']]);

    // Preference-auth (non-interactive), missing a required preference.
    cleanup();
    setLocale('en');
    render(
      <SourceProviderRow
        provider={
          {
            manifest: makeManifest({
              name: 'prefs-provider',
              title: 'Prefs Provider',
              preferences: [{ name: 'apiKey', title: 'API key', type: 'password', required: true }],
            }),
            listProjects: () => Promise.resolve({ items: [] }),
            listContainers: () => Promise.resolve({ items: [] }),
            listFiles: () => Promise.resolve({ items: [] }),
            download: () => Promise.reject(new Error('not exercised')),
          } as unknown as FileSourceProvider
        }
        sourceHost={new SourceHost()}
        prefsVersion={0}
        onOpenSettings={() => {}}
        onBrowse={() => {}}
      />,
    );
    assertLocalized([['sources.sourceProviderRow.addRequiredSettings']]);
  });
});

// ── SourceSettingsDialog ──

describe('SourceSettingsDialog localization', () => {
  it('translates the interpolated title, the local-storage notice, and the save/forget/test buttons', () => {
    const manifest = makeManifest({
      title: 'Fixture Provider',
      preferences: [{ name: 'region', title: 'Region', type: 'textfield', required: false }],
    });
    const onTestConnection = (): Promise<ConnectionTestResult> => Promise.resolve({ ok: true, message: 'ok' });
    render(
      <SourceSettingsDialog
        manifest={manifest}
        open
        onOpenChange={() => {}}
        onSave={() => {}}
        onForget={() => {}}
        onTestConnection={onTestConnection}
      />,
    );

    assertLocalized([
      ['sources.sourceSettingsDialog.title', { title: 'Fixture Provider' }],
      ['sources.sourceSettingsDialog.localStorageNotice'],
      ['sources.sourceSettingsDialog.forgetSavedValues'],
      ['sources.sourceSettingsDialog.testConnection'],
      ['sources.sourceSettingsDialog.save'],
    ]);
  });

  it('translates the dropdown placeholder', () => {
    const manifest = makeManifest({
      preferences: [
        {
          name: 'environment',
          title: 'Environment',
          type: 'dropdown',
          required: false,
          options: [{ label: 'Production', value: 'prod' }],
        },
      ],
    });
    render(<SourceSettingsDialog manifest={manifest} open onOpenChange={() => {}} onSave={() => {}} />);
    assertLocalized([['sources.sourceSettingsDialog.selectPlaceholder']]);
  });
});

// ── SourcesPanel ──
//
// `SourcesPanel` reads `useSourceHost()`, so it is mounted under the real
// `SourceHostProvider` (the same pattern `SourceBrowserFavouriteJump.test.tsx`
// uses) rather than a fixture host — `registered-providers.ts` always
// registers three real providers that never fail to construct, which is
// exactly why the provider-list-dependent keys (`noProviders`,
// `unavailableProviders`, `failedToRegister`, …) are out of scope here (see
// the file header).
describe('SourcesPanel chrome localization', () => {
  it('translates the panel title and the close button aria-label', () => {
    render(
      <SourceHostProvider>
        <SourcesPanel onClose={() => {}} />
      </SourceHostProvider>,
    );

    assertLocalized([
      ['sources.sourcesPanel.title'],
      ['sources.sourcesPanel.closeAria'],
    ]);
  });

  it('composes the whole provider-failure sentence as one translatable message, not fixed fragments (#4918 slice 5b review)', () => {
    // A real registration failure (`SourcesPanel`'s `registrationFailures`
    // come from `SourceHost.getRegistrationFailures()`) needs a provider
    // whose manifest collides with one of `SourceHostProvider`'s own three
    // built-in providers — it exposes no injection point for a fixture
    // host (see the file header), so this proves the CATALOGUE CONTRACT
    // directly instead: `sources.sourcesPanel.failedToRegister` is one
    // whole sentence with both `{provider}` and `{reason}` as parameters,
    // so a locale can reorder them — not `{provider}` fixed in JSX before a
    // translated middle phrase before a fixed `{reason}` after, which no
    // locale could ever reorder.
    const key = 'sources.sourcesPanel.failedToRegister' as const;
    assert.equal(
      resolve(key, { provider: 'my-provider', reason: 'bad api version' }),
      'my-provider failed to register: bad api version',
    );

    // A locale is free to move both placeholders anywhere in the sentence —
    // proof it is one whole message a translator edits, not two fixed
    // fragments around an untranslatable JSX span.
    registerLocale('sources-failed-to-register-reordered', {
      [key]: '{reason} — {provider} konnte nicht registriert werden',
    });
    setLocale('sources-failed-to-register-reordered');
    assert.equal(
      resolve(key, { provider: 'my-provider', reason: 'bad api version' }),
      'bad api version — my-provider konnte nicht registriert werden',
    );
    setLocale('en');
  });

  it('keeps the provider emphasized when a locale reorders the complete failure sentence', () => {
    registerLocale('sources-failure-reordered-markup', {
      'sources.sourcesPanel.failedToRegister': '{reason} — provider {provider} failed',
    });
    act(() => setLocale('sources-failure-reordered-markup'));
    const container = render(
      <RegistrationFailureMessage provider="my-provider" reason="bad api version" />,
    );

    assert.equal(container.textContent, 'bad api version — provider my-provider failed');
    const emphasized = container.querySelector('.font-medium');
    assert.equal(emphasized?.textContent, 'my-provider');
  });

  it('emphasizes every repeated provider placeholder in a valid locale', () => {
    registerLocale('sources-failure-repeated-provider', {
      'sources.sourcesPanel.failedToRegister': '{provider} failed; contact {provider}: {reason}',
    });
    act(() => setLocale('sources-failure-repeated-provider'));
    const container = render(
      <RegistrationFailureMessage provider="my-provider" reason="bad api version" />,
    );

    assert.equal(container.textContent, 'my-provider failed; contact my-provider: bad api version');
    assert.deepEqual(
      [...container.querySelectorAll('.font-medium')].map((element) => element.textContent),
      ['my-provider', 'my-provider'],
    );
  });

  it('does not interpret provider-marker text inside a diagnostic reason', () => {
    const reason = 'literal \uE000provider\uE001 from upstream';
    const container = render(<RegistrationFailureMessage provider="my-provider" reason={reason} />);
    assert.equal(container.textContent, `my-provider failed to register: ${reason}`);
    assert.equal(container.querySelectorAll('.font-medium').length, 1);
  });
});
