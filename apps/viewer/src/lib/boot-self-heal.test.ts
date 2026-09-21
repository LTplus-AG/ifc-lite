/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import vm from 'node:vm';

type Listener = (event?: { target?: unknown }) => void;

interface BootHarness {
  root: { childElementCount: number };
  fireLoad(): void;
  runTimers(): void;
  reloads(): number;
}

function bootScript(): string {
  const html = readFileSync(join(process.cwd(), 'index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1] ?? '');
  const script = scripts.find((candidate) => candidate.includes('[boot-self-heal]'));
  assert.ok(script, 'index.html contains the inline boot self-heal');
  return script;
}

function harness(initialChildren: number): BootHarness {
  const root = { childElementCount: initialChildren };
  const listeners = new Map<string, Listener[]>();
  const timers: Array<() => void> = [];
  let reloadCount = 0;
  let cookie = '';
  const storage = new Map<string, string>();
  const document = {
    readyState: 'complete',
    get cookie() { return cookie; },
    set cookie(value: string) { cookie = value; },
    getElementById: (id: string) => id === 'root' ? root : null,
    querySelector: () => null,
    addEventListener: (type: string, listener: Listener) => {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
  };
  const window = {
    addEventListener: (type: string, listener: Listener) => {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
  };
  vm.runInNewContext(bootScript(), {
    console: { warn: () => undefined },
    document,
    location: { hostname: 'localhost', reload: () => { reloadCount += 1; } },
    MutationObserver: class { observe() {} disconnect() {} },
    sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value); },
    },
    setTimeout: (callback: () => void) => { timers.push(callback); return timers.length; },
    window,
  });
  return {
    root,
    fireLoad: () => { for (const listener of listeners.get('load') ?? []) listener(); },
    runTimers: () => { for (const timer of timers.splice(0)) timer(); },
    reloads: () => reloadCount,
  };
}

describe('inline boot self-heal', () => {
  it('never converts a post-mount root teardown into a recovery reload (#5124)', () => {
    const page = harness(1);
    page.fireLoad();
    page.root.childElementCount = 0;
    page.runTimers();
    assert.equal(page.reloads(), 0);
  });

  it('still reloads a document that never mounted', () => {
    const page = harness(0);
    page.fireLoad();
    page.runTimers();
    assert.equal(page.reloads(), 1);
  });
});
