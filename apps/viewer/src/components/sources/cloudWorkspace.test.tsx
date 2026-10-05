/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act, StrictMode } from 'react';
import { PLUGIN_API_VERSION, type FileSourceProvider, type SourceFile, type PluginContext } from '@ifc-lite/plugin-api';
import { render, cleanup, click, type } from '@/test/render.js';
import { SourceHostProvider } from '@/services/sources/SourceHostProvider';
import { SourceHost } from '@/services/sources/source-host';
import { saveFavourites } from '@/lib/sources/favourites';
import { syncSourceCatalogCacheOwner } from '@/lib/sources/persistence';
import { SourcesPanel } from './SourcesPanel';
import { SourceBrowser } from './SourceBrowser';

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
beforeEach(() => localStorage.clear());
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
    const more = [...ui.querySelectorAll('button')].find((button) => button.textContent === 'Continue searching');
    if (more) { click(more); await pump(); }
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
});
