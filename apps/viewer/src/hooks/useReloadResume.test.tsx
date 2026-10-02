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
import { __resetReloadResumeForTests, noteModelLoadIntent, persistResumeIntent } from '@/lib/reload-resume';
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
function previousPageReloaded(files: string[], trigger: 'automatic' | 'user' = 'automatic'): void {
  files.forEach((name, i) => noteModelLoadIntent(name, i === 0 ? 'primary' : 'federated'));
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
      readCached: async (name) => new File(['ISO-10303-21;'], name),
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
    noteModelLoadIntent('huge.ifc', 'primary');
    persistResumeIntent('automatic');
    const { takeResumeIntent } = await import('@/lib/reload-resume');
    takeResumeIntent();
    noteModelLoadIntent('huge.ifc', 'primary');
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

  it('does nothing on an ordinary boot', async () => {
    const routed: string[][] = [];
    render(<Host ready route={(files) => routed.push(files.map((f) => f.name))} deps={{ readCached: async () => null, notify: () => {} }} />);
    await flush();
    assert.deepEqual(routed, []);
    assert.equal(captured.length, 0);
  });
});
