/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Boot side of the stale-deployment reload: the models that were open come
 * back from the recent-files cache, or the user is told which file to open
 * again. Driven through the real hook, sessionStorage and posthog sink.
 */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, render } from '@/test/render.js';
import { posthog } from '@/lib/analytics';
import { scrubEvent } from '@/lib/analytics-scrub';
import {
  __resetReloadResumeForTests, markLocalModelFiles, persistResumeIntent, setOpenModelsSource, takeResumeIntent,
} from '@/lib/reload-resume';
import { useViewerStore } from '@/store';
import type { FederatedModel } from '@/store/types';
import { useReloadResume, type ReloadResumeDeps } from './useReloadResume';

const realCapture = posthog.capture;
let captured: Array<{ event: string; properties: Record<string, unknown> }> = [];

beforeEach(() => {
  __resetReloadResumeForTests();
  sessionStorage.clear();
  captured = [];
  posthog.capture = ((event: string, properties?: Record<string, unknown>) => {
    captured.push({ event, properties: { ...properties } });
  }) as typeof posthog.capture;
});

afterEach(() => {
  cleanup();
  posthog.capture = realCapture;
});

/** A previous page's reload: what `reloadKeepingOpenModels` leaves behind. */
function previousPageReloaded(files: Array<string | File>, trigger: 'automatic' | 'user' = 'automatic'): void {
  const open = files.map((f) => (typeof f === 'string' ? new File(['x'], f) : f));
  markLocalModelFiles(open);
  setOpenModelsSource(() => open.map((sourceFile) => ({ sourceFile, loadState: 'complete' })));
  persistResumeIntent(trigger);
  __resetReloadResumeForTests(); // the new page starts with fresh module memory
}

async function flush(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

function Host(props: { ready: boolean; route: (files: File[]) => void; deps: ReloadResumeDeps; onPick?: () => void }) {
  useReloadResume(props.ready, props.route, props.onPick ?? (() => {}), props.deps);
  return null;
}

describe('useReloadResume', () => {
  it('reopens cached models through the ingestion router once loading is possible', async () => {
    previousPageReloaded(['tower.ifc', 'mep.ifc']);
    const routed: string[][] = [];
    const notices: string[] = [];
    const deps: ReloadResumeDeps = {
      readCached: async (name) => new File(['x'], name),
      notify: (text) => notices.push(text),
    };
    const route = (files: File[]) => routed.push(files.map((f) => f.name));

    render(<Host ready={false} route={route} deps={deps} />);
    await flush();
    assert.deepEqual(routed, [], 'nothing loads before WebGPU is confirmed');
    cleanup();
    render(<Host ready route={route} deps={deps} />);
    await flush();
    assert.deepEqual(routed, [['tower.ifc', 'mep.ifc']]);
    assert.deepEqual(notices, []);
  });

  it('asks the user to reopen a file the cache does not hold, by name, with an open action', async () => {
    previousPageReloaded(['tower.ifc', 'huge.ifc']);
    const routed: string[][] = [];
    const notices: Array<{ text: string; label: string; onClick: () => void }> = [];
    let picks = 0;
    const deps: ReloadResumeDeps = {
      readCached: async (name) => (name === 'tower.ifc' ? new File(['x'], name) : null),
      notify: (text, action) => notices.push({ text, ...action }),
    };
    render(<Host ready route={(files) => routed.push(files.map((f) => f.name))} deps={deps} onPick={() => { picks += 1; }} />);
    await flush();
    assert.deepEqual(routed, [['tower.ifc']]);
    assert.equal(notices.length, 1);
    assert.match(notices[0].text, /"huge\.ifc"/);
    assert.doesNotMatch(notices[0].text, /tower\.ifc/);
    notices[0].onClick();
    assert.equal(picks, 1);
  });

  it('reports counts only: no file name survives the capture or the scrubber', async () => {
    previousPageReloaded(['Client Tower Rev B.ifc', 'missing.ifc']);
    const deps: ReloadResumeDeps = {
      readCached: async (name) => (name === 'missing.ifc' ? null : new File(['x'], name)),
      notify: () => {},
    };
    render(<Host ready route={() => {}} deps={deps} />);
    await flush();
    const event = captured.find((c) => c.event === 'stale_reload_resumed');
    assert.ok(event, 'stale_reload_resumed captured');
    assert.deepEqual(event.properties, { reopened_count: 1, prompted_count: 1, auto_reopen: true });
    const scrubbed = scrubEvent({ event: event.event, properties: { ...event.properties } });
    assert.deepEqual(scrubbed?.properties, event.properties, 'nothing in it is scrubbed away');
    assert.doesNotMatch(JSON.stringify(captured), /Tower|missing/);
  });

  it('after a second automatic reload from an automatic reopen, only prompts (loop guard)', async () => {
    // Page 1 -> page 2 reopened automatically; page 2's load failed and reloaded automatically.
    const huge = new File(['x'], 'huge.ifc');
    markLocalModelFiles([huge]);
    setOpenModelsSource(() => [{ sourceFile: huge, loadState: 'streaming-geometry' }]);
    persistResumeIntent('automatic');
    takeResumeIntent();
    persistResumeIntent('automatic');
    __resetReloadResumeForTests();

    const routed: string[][] = [];
    const notices: string[] = [];
    let reads = 0;
    const deps: ReloadResumeDeps = {
      readCached: async (name) => { reads += 1; return new File(['x'], name); },
      notify: (text) => notices.push(text),
    };
    render(<Host ready route={(files) => routed.push(files.map((f) => f.name))} deps={deps} />);
    await flush();
    assert.deepEqual(routed, [], 'no automatic reopen this time');
    assert.equal(reads, 0);
    assert.equal(notices.length, 1);
  });

  it('reads the viewer store at reload time: a model removed before the reload is not carried (#6721 review)', async () => {
    const wall = new File(['x'], 'hello-wall.ifc');
    const second = new File(['x'], 'second.ifc');
    markLocalModelFiles([wall, second]);
    const model = (id: string, sourceFile: File) => ({ id, name: sourceFile.name, sourceFile, loadState: 'complete' }) as unknown as FederatedModel;
    render(<Host ready={false} route={() => {}} deps={{ readCached: async () => null, notify: () => {} }} />);
    await flush();
    useViewerStore.setState({ models: new Map([['a', model('a', wall)], ['b', model('b', second)]]) });
    useViewerStore.setState({ models: new Map([['a', model('a', wall)]]) }); // removeModel('b')
    persistResumeIntent('automatic');
    assert.deepEqual(takeResumeIntent()?.files.map((f) => f.name), ['hello-wall.ifc']);
    useViewerStore.setState({ models: new Map() });
  });

  it('does not load a cached blob of a different size under the same name; prompts for it instead', async () => {
    previousPageReloaded(['tower.ifc']);
    const routed: string[][] = [];
    const notices: string[] = [];
    const deps: ReloadResumeDeps = {
      readCached: async (name) => new File(['a different, newer tower'], name),
      notify: (text) => notices.push(text),
    };
    render(<Host ready route={(files) => routed.push(files.map((f) => f.name))} deps={deps} />);
    await flush();
    assert.deepEqual(routed, []);
    assert.equal(notices.length, 1);
    assert.match(notices[0], /"tower\.ifc"/);
  });

  it('two federated files with one name: the cached one reopens, the other is prompted, neither is merged away', async () => {
    previousPageReloaded([new File(['site A'], 'model.ifc'), new File(['site B, other'], 'model.ifc')]);
    const routed: number[][] = [];
    const notices: string[] = [];
    const deps: ReloadResumeDeps = {
      readCached: async (name) => new File(['site A'], name), // the cache holds one blob per name
      notify: (text) => notices.push(text),
    };
    render(<Host ready route={(files) => routed.push(files.map((f) => f.size))} deps={deps} />);
    await flush();
    assert.deepEqual(routed, [[6]]);
    assert.equal(notices.length, 1);
    assert.match(notices[0], /"model\.ifc"/);
  });

  it('a cache read that rejects is a prompt, not an unhandled rejection', async () => {
    previousPageReloaded(['tower.ifc']);
    const notices: string[] = [];
    const deps: ReloadResumeDeps = {
      readCached: async () => { throw new Error('IndexedDB blocked'); },
      notify: (text) => notices.push(text),
    };
    render(<Host ready route={() => assert.fail('nothing to route')} deps={deps} />);
    await flush();
    assert.equal(notices.length, 1);
  });

  it('does nothing on an ordinary boot', async () => {
    const routed: string[][] = [];
    render(<Host ready route={(files) => routed.push(files.map((f) => f.name))} deps={{ readCached: async () => null, notify: () => {} }} />);
    await flush();
    assert.deepEqual(routed, []);
    assert.equal(captured.length, 0);
  });
});
