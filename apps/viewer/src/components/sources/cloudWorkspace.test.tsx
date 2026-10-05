/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { act, StrictMode } from 'react';
import { PLUGIN_API_VERSION, type FileSourceProvider, type SourceFile, type PluginContext } from '@ifc-lite/plugin-api';
import { render, cleanup, click, type } from '@/test/render.js';
import { SourceHostProvider } from '@/services/sources/SourceHostProvider';
import { SourceHost } from '@/services/sources/source-host';
import { saveFavourites } from '@/lib/sources/favourites';
import { syncSourceCatalogCacheOwner } from '@/lib/sources/persistence';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { SourcesPanel } from './SourcesPanel';
import { SourceBrowser } from './SourceBrowser';
import { createSourceWideSearchWalk } from './sourceWideSearchWalk';

// #6897: same file id in different projects is deliberately valid. Search must
// retain its addressing project, including results reached through pagination.
const file: SourceFile = { id: 'model', name: 'Tower.ifc', containerId: 'models', currentRevisionId: 'r1', sizeBytes: 4096 };
function provider(): FileSourceProvider {
  return {
    manifest: { name: 'workspace-fixture', title: 'Workspace Files', api: PLUGIN_API_VERSION,
      auth: 'preferences', preferences: [], permissions: { network: [] }, contributes: { fileSources: [] },
      capabilities: { containerListing: 'direct-children', listFilesIsRecursive: false, search: true,
        revisionHistory: false, downloadHistoricalRevisions: false, changeDetection: false } },
    listProjects: async (_ctx, options) => options?.cursor === 'projects-next'
      ? { items: [{ id: 'p2', name: 'Second Project' }] }
      : { items: [{ id: 'p1', name: 'First Project' }], cursor: 'projects-next' },
    listContainers: async (_ctx, _project, parent) => ({ items: parent ? [] : [{ id: 'root', name: 'Documents' }] }),
    listFiles: async () => ({ items: [file] }),
    searchFiles: async (_ctx, project, query, _filter, options) => {
      if (query !== 'Tower') return { items: [] };
      if (project === 'p1' && !options?.cursor) return { items: [], cursor: 'filtered-next' };
      return { items: [file] };
    },
    download: async () => new ArrayBuffer(0),
  };
}
function browser(p: FileSourceProvider, onDownload: (selection: {projectId: string; files: readonly SourceFile[]}) => void = () => {}, onBack: () => void = () => {}) {
  return render(<SourceHostProvider additionalProviders={[() => p]}><SourceBrowser provider={p} ctx={context(p)} busy={false} downloadStates={new Map()} onDownload={onDownload} onBack={onBack} /></SourceHostProvider>);
}
function context(p: FileSourceProvider): PluginContext {
  const host = new SourceHost(); host.register(p); return host.createContext(p.manifest, {});
}
async function pump() { for (let i = 0; i < 12; i++) await act(async () => { await Promise.resolve(); }); }
function labelled(ui: HTMLElement, label: string) {
  const button = ui.querySelector(`[aria-label="${label}"]`); assert.ok(button, label); return button;
}
function named(ui: HTMLElement, name: string) {
  const button = [...ui.querySelectorAll('button')].find((item) => item.textContent === name); assert.ok(button, name); return button;
}
beforeEach(() => { localStorage.clear(); useViewerStore.setState({ models: new Map(), sourceTags: new Map() }); });
afterEach(cleanup);

describe('Cloud workspace (#6897)', () => {
  it('expands from the source name, exposes root file search, and reopens a pinned provider after remount', async () => {
    const p = provider();
    const mount = () => render(<StrictMode><SourceHostProvider additionalProviders={[() => p]}><SourcesPanel onClose={() => {}} /></SourceHostProvider></StrictMode>);
    let ui = mount(); await pump();
    const source = labelled(ui, 'Browse Workspace Files');
    assert.equal(source.getAttribute('aria-expanded'), 'false');
    click(source); await pump();
    assert.equal(labelled(ui, 'Browse Workspace Files').getAttribute('aria-expanded'), 'true');
    assert.ok(labelled(ui, 'Search files in Workspace Files'), 'no folder must be selected before search is available');
    click(labelled(ui, 'Pin Workspace Files')); await pump();
    cleanup(); ui = mount(); await pump();
    assert.equal(labelled(ui, 'Browse Workspace Files').getAttribute('aria-expanded'), 'true');
    assert.equal(labelled(ui, 'Unpin Workspace Files').getAttribute('aria-pressed'), 'true');
    assert.equal(ui.querySelector('ul.space-y-2 > li')?.textContent?.includes('Workspace Files'), true, 'pinned provider sorts first');
    click(labelled(ui, 'Browse Workspace Files')); await pump();
    assert.equal(labelled(ui, 'Browse Workspace Files').getAttribute('aria-expanded'), 'false', 'manual collapse must not immediately auto-open again');
  });

  it('reports unavailable pin storage while leaving provider navigation usable', async () => {
    const getItem = localStorage.getItem.bind(localStorage);
    const denied = mock.method(localStorage, 'getItem', (key: string) => {
      if (key === 'ifc-lite-source-provider-pins') throw new DOMException('Storage denied', 'SecurityError');
      return getItem(key);
    });
    try {
      const p = provider();
      const ui = render(<SourceHostProvider additionalProviders={[() => p]}><SourcesPanel onClose={() => {}} /></SourceHostProvider>);
      await pump();
      assert.ok(ui.querySelector('[role="alert"]')?.textContent?.includes('pinned sources could not be restored'));
      click(labelled(ui, 'Browse Workspace Files')); await pump();
      assert.ok(labelled(ui, 'Search files in Workspace Files'), 'storage failure does not disable cloud access');
    } finally { denied.mock.restore(); }
  });

  it('pins the current folder above files and opens it directly from the overview', async () => {
    const p = provider();
    const ui = render(<SourceHostProvider additionalProviders={[() => p]}><SourcesPanel onClose={() => {}} /></SourceHostProvider>);
    await pump(); click(labelled(ui, 'Browse Workspace Files')); await pump();
    click(named(ui, 'First Project')); await pump();
    click(named(ui, 'Documents')); await pump();
    click(labelled(ui, 'Pin current folder: Documents')); await pump();
    const shortcuts = labelled(ui, 'Favorite folders');
    assert.ok(shortcuts.textContent?.includes('Documents'));
    const remove = labelled(ui, 'Remove favourite: Documents');
    const favourite = remove.closest('li')?.querySelector('button'); assert.ok(favourite);
    click(labelled(ui, 'Browse Workspace Files')); await pump();
    click(favourite); await pump();
    assert.ok(labelled(ui, 'Current folder').textContent?.includes('Documents'), 'favorite jumps directly into the folder');
    click(labelled(ui, 'Remove favourite: Documents')); await pump();
    assert.equal(ui.querySelector('[aria-label="Favorite folders"]'), null, 'removing an overview favorite updates the open browser too');
    assert.ok(labelled(ui, 'Pin current folder: Documents'));
  });

  it('does not open a pinned signed-out provider or reveal its previous account favorites', async () => {
    const original = provider();
    const p: FileSourceProvider = { ...original, manifest: { ...original.manifest, auth: 'interactive' },
      auth: { restore: async () => null, signIn: async () => ({ id: 'new' }), signOut: async () => {}, getIdentity: async () => null } };
    localStorage.setItem('ifc-lite-source-provider-pins', JSON.stringify([p.manifest.name]));
    syncSourceCatalogCacheOwner(p.manifest.name, 'previous-account');
    saveFavourites(p.manifest.name, [{ providerId: p.manifest.name, kind: 'folder', projectId: 'p1', projectName: 'Private project', fileAreaId: 'root', fileAreaName: 'Private area', containerId: 'secret', containerName: 'Confidential folder', identityId: 'previous-account', addedAt: 1 }]);
    const ui = render(<SourceHostProvider additionalProviders={[() => p]}><SourcesPanel onClose={() => {}} /></SourceHostProvider>);
    await pump();
    assert.equal(labelled(ui, 'Browse Workspace Files').getAttribute('aria-expanded'), 'false');
    assert.ok(labelled(ui, 'Sign in to Workspace Files'));
    assert.equal(ui.textContent?.includes('Confidential folder'), false, 'old account folder names remain hidden');
    assert.equal(ui.querySelector('[aria-label="Search files in Workspace Files"]'), null);
    click(labelled(ui, 'Sign in to Workspace Files')); await pump();
    assert.equal(labelled(ui, 'Browse Workspace Files').getAttribute('aria-expanded'), 'true', 'pinned provider opens after successful sign-in');
    click(labelled(ui, 'Sign out of Workspace Files')); await pump();
    assert.equal(ui.querySelector('[aria-label="Search files in Workspace Files"]'), null, 'search/browser state disappears on sign-out');
  });

  it('searches before folder navigation and opens a paginated match with its original project reference', async () => {
    const p = provider();
    const imports: Array<{projectId: string; files: readonly SourceFile[]}> = [];
    const ui = browser(p, (selection) => imports.push(selection));
    await pump();
    type(labelled(ui, 'Search files in Workspace Files') as HTMLInputElement, 'Tower');
    await act(async () => { ui.querySelector('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); });
    await pump();
    assert.ok(ui.textContent?.includes('First Project'));
    click(named(ui, 'Continue searching')); await pump();
    assert.ok(ui.textContent?.includes('Second Project'));
    const opens = [...ui.querySelectorAll('button')].filter((button) => button.textContent === 'Open Tower.ifc');
    assert.equal(opens.length, 2, 'identical file ids in different projects stay distinct');
    click(opens[1]);
    assert.deepEqual(imports, [{ projectId: 'p2', files: [file] }]);
  });

  it('marks only genuinely loaded project/file/revision results and clears the indicator when their model closes', async () => {
    const p = provider();
    useViewerStore.setState({ ...fixtureModels(fixtureModel('loaded')), sourceTags: new Map([['loaded', {
      provider: p.manifest.name, projectId: 'p2', containerId: 'models', fileId: file.id, revisionId: 'r1', loadedAt: 1,
    }]]) });
    const ui = browser(p); await pump();
    type(labelled(ui, 'Search files in Workspace Files') as HTMLInputElement, 'Tower');
    await act(async () => { ui.querySelector('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); });
    await pump();
    assert.equal(ui.textContent?.includes('1 model open in viewer'), false, 'same file id in the other project is not marked loaded');
    click(named(ui, 'Continue searching')); await pump();
    assert.ok(ui.textContent?.includes('1 model open in viewer'));
    act(() => { useViewerStore.setState({ models: new Map() }); });
    assert.equal(ui.textContent?.includes('1 model open in viewer'), false);
  });

  it('imports the selected historical revision from a provider-root result', async () => {
    const p = provider();
    p.listRevisions = async () => ({ items: [{ id: 'older', label: 'Earlier version', createdAt: '2026-01-01' }] });
    const imports: Array<{projectId: string; files: readonly SourceFile[]}> = [];
    const ui = browser(p, (selection) => imports.push(selection)); await pump();
    type(labelled(ui, 'Search files in Workspace Files') as HTMLInputElement, 'Tower');
    await act(async () => { ui.querySelector('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); });
    await pump();
    const details = ui.querySelector('details'); assert.ok(details);
    await act(async () => { details.open = true; details.dispatchEvent(new window.Event('toggle')); });
    await pump();
    const revision = [...ui.querySelectorAll('button')].find((button) => button.textContent?.includes('Earlier version')); assert.ok(revision);
    click(revision); await pump(); click(named(ui, 'Open Tower.ifc'));
    assert.equal(imports[0]?.files[0].currentRevisionId, 'older');
  });

  for (const name of ['dropbox', 'msgraph']) it(`enters the signed-in ${name} account root without a redundant project click`, async () => {
    const original = provider();
    const p: FileSourceProvider = { ...original, manifest: { ...original.manifest, name },
      listProjects: async () => ({ items: [{ id: 'account', name: 'Personal account' }] }) };
    let back = 0;
    const ui = browser(p, () => {}, () => back++); await pump();
    assert.ok(named(ui, 'Documents'), 'account folder contents appear automatically');
    assert.equal([...ui.querySelectorAll('button')].some((button) => button.textContent === 'Personal account'), false);
    assert.ok(labelled(ui, 'Search files in Workspace Files'));
    click(labelled(ui, 'Back')); await pump();
    assert.equal(back, 1, 'Back leaves the personal account instead of re-entering it automatically');
  });

  it('keeps project selection reachable when a personal-drive provider lists multiple projects', async () => {
    const original = provider(); let back = 0;
    const p: FileSourceProvider = { ...original, manifest: { ...original.manifest, name: 'msgraph' },
      listProjects: async () => ({ items: [{ id: 'p1', name: 'First Project' }, { id: 'p2', name: 'Second Project' }] }) };
    const ui = browser(p, () => {}, () => back++); await pump();
    click(named(ui, 'First Project')); await pump(); click(labelled(ui, 'Back')); await pump();
    assert.ok(named(ui, 'Second Project')); assert.equal(back, 0, 'manual project selection returns to projects');
  });

  it('bounds empty-result work and continues through later projects without dropping them', async () => {
    const p = provider(); let requests = 0;
    p.listProjects = async (_ctx, options) => {
      requests++; const offset = Number(options?.cursor ?? 0);
      return { items: [{ id: String(offset), name: String(offset) }], cursor: offset < 8 ? String(offset + 1) : undefined };
    };
    p.searchFiles = async (_ctx, project) => { requests++; return { items: project === '8' ? [file] : [] }; };
    const ui = browser(p); await pump(); requests = 0;
    type(labelled(ui, 'Search files in Workspace Files') as HTMLInputElement, 'Tower');
    await act(async () => { ui.querySelector('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); });
    await pump();
    assert.ok(requests <= 10); assert.ok(ui.textContent?.includes('No matches in the projects searched so far'));
    click(named(ui, 'Continue searching')); await pump();
    assert.ok(ui.textContent?.includes('Tower.ifc'));
    assert.equal([...ui.querySelectorAll('button')].some((button) => button.textContent === 'Continue searching'), false);

  });

  it('searches names through folders when native search is unavailable, including a cyclic folder reference', async () => {
    const original = provider(); let fileRequests = 0;
    const p: FileSourceProvider = { ...original, searchFiles: undefined,
      manifest: { ...original.manifest, capabilities: { ...original.manifest.capabilities, search: false } },
      listProjects: async () => ({ items: [{ id: 'p', name: 'Project' }] }),
      listContainers: async (_ctx, _project, parent) => ({ items: parent === 'child'
        ? [{ id: 'root', name: 'Documents' }] : [{ id: parent ? 'child' : 'root', name: parent ? 'Models' : 'Documents' }] }),
      listFiles: async (_ctx, _project, container) => { fileRequests++; return { items: container === 'child' ? [{ ...file, containerId: 'child' }] : [] }; },
    };
    const imports: Array<{projectId: string; files: readonly SourceFile[]}> = [];
    const ui = browser(p, (selection) => imports.push(selection)); await pump();
    type(labelled(ui, 'Search files in Workspace Files') as HTMLInputElement, 'tower');
    await act(async () => { ui.querySelector('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); });
    await pump();
    assert.ok(ui.textContent?.includes('Tower.ifc'));
    click(named(ui, 'Open Tower.ifc'));
    assert.equal(imports[0]?.projectId, 'p'); assert.equal(imports[0]?.files[0].containerId, 'child');
    click(named(ui, 'Continue searching')); await pump();
    assert.equal(fileRequests, 2, 'cycle does not re-read root or child');
  });

  it('aborts provider-wide requests when the user cancels', async () => {
    const p = provider(); const signals: AbortSignal[] = [];
    p.searchFiles = async (_ctx, _project, _query, _filter, options) => {
      const signal = options?.signal; assert.ok(signal); signals.push(signal);
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true }));
    };
    const ui = browser(p); await pump();
    type(labelled(ui, 'Search files in Workspace Files') as HTMLInputElement, 'Tower');
    await act(async () => { ui.querySelector('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); });
    await pump(); assert.equal(signals.length, 1);
    click(named(ui, 'Back to browsing')); await pump();
    assert.equal(signals[0].aborted, true);
    assert.equal([...ui.querySelectorAll('button')].some((button) => button.textContent === 'Open Tower.ifc'), false);

  });

  it('clears project search when a favorite folder is selected (#6898)', async () => {
    const p = provider();
    p.listFiles = async () => ({ items: [{ ...file, name: 'Folder.ifc', containerId: 'root' }] });
    p.searchFiles = async () => ({ items: [{ ...file, name: 'Elsewhere.ifc' }] });
    const ui = browser(p); await pump();
    click(named(ui, 'First Project')); await pump(); click(named(ui, 'Documents')); await pump();
    click(labelled(ui, 'Pin current folder: Documents')); await pump();
    const input = labelled(ui, 'Search files in project') as HTMLInputElement;
    type(input, 'Elsewhere');
    await act(async () => { input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    await pump(); assert.ok(ui.textContent?.includes('Elsewhere.ifc'));
    click(named(labelled(ui, 'Favorite folders') as HTMLElement, 'Documents')); await pump();
    assert.equal(ui.textContent?.includes('Elsewhere.ifc'), false);
    assert.ok(ui.textContent?.includes('Folder.ifc'));
    assert.equal(input.value, '');
  });

  it('keeps the download browser visible when another provider favorite is pressed (#6898)', async () => {
    const p = provider();
    const other: FileSourceProvider = { ...provider(), manifest: { ...p.manifest, name: 'other-provider', title: 'Other Files' } };
    p.download = async (_ctx, _ref, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true });
    });
    saveFavourites(other.manifest.name, [{ providerId: other.manifest.name, kind: 'folder', projectId: 'p1', projectName: 'First Project', fileAreaId: 'root', fileAreaName: 'Documents', containerId: 'root', containerName: 'Other folder', identityId: null, addedAt: 1 }]);
    const ui = render(<SourceHostProvider additionalProviders={[() => p, () => other]}><SourcesPanel onClose={() => {}} /></SourceHostProvider>);
    await pump(); click(labelled(ui, 'Browse Workspace Files')); await pump();
    const input = labelled(ui, 'Search files in Workspace Files') as HTMLInputElement;
    type(input, 'Tower');
    await act(async () => { ui.querySelector('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); });
    await pump(); click(named(ui, 'Open Tower.ifc')); await pump();
    const remove = labelled(ui, 'Remove favourite: Other folder');
    const favorite = remove.closest('li')?.querySelector('button'); assert.ok(favorite);
    assert.equal(favorite.disabled, true, 'shortcut visibly waits for the active download');
    click(favorite); await pump();
    assert.equal(labelled(ui, 'Browse Workspace Files').getAttribute('aria-expanded'), 'true');
    assert.equal(labelled(ui, 'Browse Other Files').getAttribute('aria-expanded'), 'false');
    click(named(ui, 'Cancel download')); await pump();
    assert.equal(favorite.disabled, false, 'navigation resumes after cancellation');
  });

  it('requests recursive files once per subtree root (#6898)', async () => {
    const original = provider(); const requested: string[] = [];
    const p: FileSourceProvider = { ...original, searchFiles: undefined,
      manifest: { ...original.manifest, capabilities: { ...original.manifest.capabilities, search: false, containerListing: 'flat-subtree', listFilesIsRecursive: true } },
      listProjects: async () => ({ items: [{ id: 'p', name: 'Project' }] }),
      listContainers: async () => ({ items: [{ id: 'root', name: 'Root' }, { id: 'child', name: 'Child', parentId: 'root' }] }),
      listFiles: async (_ctx, _project, container) => { requested.push(container); return { items: [{ ...file, containerId: 'child' }] }; },
    };
    const page = await createSourceWideSearchWalk(p, context(p), 'Tower')(undefined, new AbortController().signal);
    assert.deepEqual(requested, ['root']); assert.equal(page.items.length, 1); assert.equal(page.cursor, undefined);
  });

  it('keeps discovery search reachable for an incomplete one-project Microsoft catalog (#6898)', async () => {
    const original = provider();
    const p: FileSourceProvider = { ...original, manifest: { ...original.manifest, name: 'msgraph', capabilities: { ...original.manifest.capabilities, projectsAreDiscoverableOnly: true } },
      listProjects: async (_ctx, options) => ({ items: [{ id: options?.query ? 'p2' : 'p1', name: options?.query ? 'Discovered Project' : 'First Project' }] }) };
    const ui = browser(p); await pump();
    const search = labelled(ui, 'Search projects') as HTMLInputElement;
    type(search, 'Other site');
    await act(async () => { search.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    await pump(); click(named(ui, 'Discovered Project')); await pump();
    click(labelled(ui, 'Back')); await pump();
    assert.ok(labelled(ui, 'Search projects')); assert.ok(named(ui, 'First Project'));
  });

  it('jumps between favorites sharing folder ids in distinct projects (#6898)', async () => {
    const p = provider();
    p.listFiles = async (_ctx, project) => ({ items: [{ ...file, name: `${project}.ifc`, containerId: 'root' }] });
    saveFavourites(p.manifest.name, ['p1', 'p2'].map((projectId) => ({ providerId: p.manifest.name, kind: 'folder', projectId, projectName: projectId, fileAreaId: 'root', fileAreaName: 'Documents', containerId: 'root', containerName: projectId, identityId: null, addedAt: 1 })));
    const ui = render(<SourceHostProvider additionalProviders={[() => p]}><SourcesPanel onClose={() => {}} /></SourceHostProvider>);
    await pump();
    const shortcut = (name: string) => { const remove = labelled(ui, `Remove favourite: ${name}`); const button = remove.closest('li')?.querySelector('button'); assert.ok(button); return button; };
    click(shortcut('p1')); await pump(); assert.ok(ui.textContent?.includes('p1.ifc'));
    click(shortcut('p2')); await pump(); assert.ok(ui.textContent?.includes('p2.ifc'));
    assert.equal(ui.textContent?.includes('p1.ifc'), false, 'old project files cannot survive the favorite jump');
  });

  it('reports parseable malformed pin data instead of silently dropping pins (#6898)', async () => {
    for (const value of ['{}', '["workspace-fixture",5]']) {
      localStorage.setItem('ifc-lite-source-provider-pins', value);
      const p = provider();
      const ui = render(<SourceHostProvider additionalProviders={[() => p]}><SourcesPanel onClose={() => {}} /></SourceHostProvider>);
      await pump();
      assert.ok(ui.querySelector('[role="alert"]')?.textContent?.includes('pinned sources could not be restored'));
      click(labelled(ui, 'Browse Workspace Files')); await pump();
      assert.ok(labelled(ui, 'Search files in Workspace Files'));
      cleanup();
    }
  });

  it('opens a stored deep folder shortcut before that folder has been listed (#6898)', async () => {
    const p = provider(); const requests: string[] = [];
    p.listContainers = async (_ctx, _project, parent) => ({ items: parent ? [{ id: 'models', name: 'Models', parentId: 'root' }] : [{ id: 'root', name: 'Documents' }] });
    p.listFiles = async (_ctx, _project, container) => { requests.push(container); return { items: container === 'archive' ? [{ ...file, name: 'Archive.ifc', containerId: 'archive' }] : [] }; };
    saveFavourites(p.manifest.name, [{ providerId: p.manifest.name, kind: 'folder', projectId: 'p1', projectName: 'First Project', fileAreaId: 'root', fileAreaName: 'Documents', containerId: 'archive', containerName: 'Deep archive', identityId: null, addedAt: 1 }]);
    const ui = browser(p); await pump();
    click(named(ui, 'First Project')); await pump(); click(named(ui, 'Documents')); await pump();
    assert.deepEqual(requests, ['root'], 'deep folder has not been fetched yet');
    click(named(labelled(ui, 'Favorite folders') as HTMLElement, 'Deep archive')); await pump();
    assert.deepEqual(requests, ['root', 'archive']); assert.ok(ui.textContent?.includes('Archive.ifc'));
  });

  it('returns from a favorite shortcut to the overview and can browse another project (#6898)', async () => {
    const p = provider();
    p.listProjects = async () => ({ items: [{ id: 'p1', name: 'First Project' }, { id: 'p2', name: 'Second Project' }] });
    p.listFiles = async (_ctx, project) => ({ items: [{ ...file, name: `${project}.ifc`, containerId: 'root' }] });
    saveFavourites(p.manifest.name, [{ providerId: p.manifest.name, kind: 'folder', projectId: 'p1', projectName: 'First Project', fileAreaId: 'root', fileAreaName: 'Documents', containerId: 'root', containerName: 'Shortcut', identityId: null, addedAt: 1 }]);
    const ui = render(<SourceHostProvider additionalProviders={[() => p]}><SourcesPanel onClose={() => {}} /></SourceHostProvider>);
    await pump();
    const remove = labelled(ui, 'Remove favourite: Shortcut'); const shortcut = remove.closest('li')?.querySelector('button'); assert.ok(shortcut);
    click(shortcut); await pump(); assert.ok(ui.textContent?.includes('p1.ifc'));
    click(labelled(ui, 'Back')); await pump(); click(labelled(ui, 'Back')); await pump();
    assert.equal(labelled(ui, 'Browse Workspace Files').getAttribute('aria-expanded'), 'false');
    click(labelled(ui, 'Browse Workspace Files')); await pump();
    click(named(ui, 'Second Project')); await pump(); click(named(ui, 'Documents')); await pump();
    assert.ok(ui.textContent?.includes('p2.ifc')); assert.equal(ui.textContent?.includes('p1.ifc'), false);
  });

  it('does not resurrect a terminal download status after clearing and repeating a search (#6898)', async () => {
    const p = provider(); p.download = async () => { throw new Error('Provider download failed'); };
    const ui = render(<SourceHostProvider additionalProviders={[() => p]}><SourcesPanel onClose={() => {}} /></SourceHostProvider>);
    await pump(); click(labelled(ui, 'Browse Workspace Files')); await pump();
    const search = async () => {
      type(labelled(ui, 'Search files in Workspace Files') as HTMLInputElement, 'Tower');
      await act(async () => { ui.querySelector('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); });
      await pump();
    };
    await search(); click(named(ui, 'Open Tower.ifc')); await pump();
    assert.ok(ui.textContent?.includes('Download failed'));
    click(named(ui, 'Back to browsing')); await pump(); await search();
    assert.ok(named(ui, 'Open Tower.ifc')); assert.equal(ui.textContent?.includes('Download failed'), false);
  });

  it('keeps the download owner open when a sign-in started earlier finishes (#6898)', async () => {
    const p = provider(); let signedIn = false; let finish: (() => void) | undefined;
    const other: FileSourceProvider = { ...provider(), manifest: { ...p.manifest, name: 'other-provider', title: 'Other Files', auth: 'interactive' },
      auth: { restore: async () => null, getIdentity: async () => signedIn ? { id: 'other-account' } : null, signOut: async () => { signedIn = false; },
        signIn: async () => new Promise((resolve) => { finish = () => { signedIn = true; resolve({ id: 'other-account' }); }; }) } };
    p.download = async (_ctx, _ref, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true });
    });
    const ui = render(<SourceHostProvider additionalProviders={[() => p, () => other]}><SourcesPanel onClose={() => {}} /></SourceHostProvider>);
    await pump(); click(labelled(ui, 'Browse Workspace Files')); await pump();
    click(labelled(ui, 'Sign in to Other Files')); await pump(); assert.ok(finish);
    type(labelled(ui, 'Search files in Workspace Files') as HTMLInputElement, 'Tower');
    await act(async () => { ui.querySelector('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); });
    await pump(); click(named(ui, 'Open Tower.ifc')); await pump();
    await act(async () => { finish!(); }); await pump();
    assert.ok(labelled(ui, 'Sign out of Other Files'), 'sign-in completes without stealing the download browser');
    assert.equal(labelled(ui, 'Browse Workspace Files').getAttribute('aria-expanded'), 'true');
    assert.equal(labelled(ui, 'Browse Other Files').getAttribute('aria-expanded'), 'false');
    click(named(ui, 'Cancel download')); await pump();
    click(labelled(ui, 'Browse Other Files')); await pump();
    assert.equal(labelled(ui, 'Browse Other Files').getAttribute('aria-expanded'), 'true');
  });

  it('preserves unreadable pins until the user explicitly resets them (#6898)', async () => {
    const original = '["dropbox",5]'; localStorage.setItem('ifc-lite-source-provider-pins', original);
    const p = provider();
    const ui = render(<SourceHostProvider additionalProviders={[() => p]}><SourcesPanel onClose={() => {}} /></SourceHostProvider>);
    await pump(); click(labelled(ui, 'Pin Workspace Files')); await pump();
    assert.equal(localStorage.getItem('ifc-lite-source-provider-pins'), original, 'failed restoration cannot authorize a destructive write');
    const denied = mock.method(localStorage, 'removeItem', () => { throw new DOMException('Storage denied', 'SecurityError'); });
    try {
      click(named(ui, 'Reset saved source pins')); await pump();
      assert.ok(ui.querySelector('[role="alert"]'), 'failed reset must keep the restore warning');
      assert.equal(localStorage.getItem('ifc-lite-source-provider-pins'), original);
    } finally { denied.mock.restore(); }
    click(named(ui, 'Reset saved source pins')); await pump();
    assert.equal(ui.querySelector('[role="alert"]'), null);
    click(labelled(ui, 'Pin Workspace Files')); await pump();
    assert.equal(labelled(ui, 'Unpin Workspace Files').getAttribute('aria-pressed'), 'true');
  });

  it('keeps a provider open when it is pinned during its download (#6898)', async () => {
    const p = provider(); let complete: (() => void) | undefined;
    p.download = async () => new Promise((resolve) => { complete = () => resolve(new ArrayBuffer(0)); });
    const ui = render(<SourceHostProvider additionalProviders={[() => p]}><SourcesPanel onClose={() => {}} /></SourceHostProvider>);
    await pump(); click(labelled(ui, 'Browse Workspace Files')); await pump();
    type(labelled(ui, 'Search files in Workspace Files') as HTMLInputElement, 'Tower');
    await act(async () => { ui.querySelector('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); });
    await pump(); click(named(ui, 'Open Tower.ifc')); await pump(); assert.ok(complete);
    click(labelled(ui, 'Pin Workspace Files')); await pump();
    await act(async () => { complete!(); }); await pump();
    assert.equal(labelled(ui, 'Browse Workspace Files').getAttribute('aria-expanded'), 'true');
    assert.ok(labelled(ui, 'Search files in Workspace Files'));
  });

  it('scopes live file progress to its project when file ids collide (#6898)', async () => {
    const p = provider();
    p.listProjects = async () => ({ items: [{ id: 'p1', name: 'First Project' }, { id: 'p2', name: 'Second Project' }] });
    p.listFiles = async () => ({ items: [{ ...file, containerId: 'root' }] });
    p.download = async (_ctx, _ref, options) => {
      options?.onProgress?.(25, 100);
      return new Promise((_resolve, reject) => { options?.signal?.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true }); });
    };
    const ui = render(<SourceHostProvider additionalProviders={[() => p]}><SourcesPanel onClose={() => {}} /></SourceHostProvider>);
    await pump(); click(labelled(ui, 'Browse Workspace Files')); await pump();
    type(labelled(ui, 'Search files in Workspace Files') as HTMLInputElement, 'Tower');
    await act(async () => { ui.querySelector('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); });
    await pump(); click(named(ui, 'Open Tower.ifc')); await pump(); assert.ok(ui.querySelector('[role="progressbar"]'));
    click(named(ui, 'Second Project')); await pump(); click(named(ui, 'Documents')); await pump();
    assert.equal(labelled(ui, 'Select Tower.ifc').closest('li')?.querySelector('[role="progressbar"]'), null, 'another project cannot inherit the ring for the same file id');
    click(labelled(ui, 'Back')); await pump(); click(labelled(ui, 'Back')); await pump();
    click(named(ui, 'First Project')); await pump(); click(named(ui, 'Documents')); await pump();
    assert.ok(labelled(ui, 'Select Tower.ifc').closest('li')?.querySelector('[role="progressbar"]'), 'returning to the owner project preserves real progress');
    click(named(ui, 'Cancel download')); await pump();
  });
});
