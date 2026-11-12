/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Test double for `load-scoreboard-browser.mjs` `browserSample` (scoreboard tests only).
 * A fake Playwright `chromium` whose single page runs only the arming probes, in this
 * process, against `globalThis`: the quiet-shell state, the boot signal and the first
 * paint. Every other page call throws, so an open that got past arming fails in phase
 * `cold` (or `warm<i>`) and one stopped by arming fails in `cold-shell`; that phase is
 * what the wiring tests read. `hook` installs `__ifc_lite_boot_settled__` and counts calls.
 */

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ALLOWED = new Set(['shellState', 'readBootSignal']);

/** Run `browserSample` against the fake; resolves to { result, hookCalls }. */
export async function fakeBrowserSample(browserSample, { arm = 'quiet', hook = undefined, side = {}, warmOpens = 0 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fake-browser-'));
  const saved = { hook: globalThis.__ifc_lite_boot_settled__, store: globalThis.__ifc_lite_viewer_store__, raf: globalThis.requestAnimationFrame, tasks: globalThis.__benchLongTasks };
  let hookCalls = 0;
  if (hook === undefined) delete globalThis.__ifc_lite_boot_settled__;
  else globalThis.__ifc_lite_boot_settled__ = () => { hookCalls++; return hook(hookCalls); };
  globalThis.__ifc_lite_viewer_store__ = {};
  globalThis.__benchLongTasks = [];
  globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(), 0);
  const page = {
    on() {}, async goto() {}, async screenshot() {}, isClosed: () => false,
    async waitForFunction(fn, arg) { if (!fn(arg)) throw new Error('fake page: condition not met'); return { jsonValue: async () => null }; },
    locator: () => ({ waitFor: async () => {}, setInputFiles: async () => { throw new Error('fake page: no file open'); } }),
    async evaluate(fn, arg) {
      if (ALLOWED.has(fn.name) || String(fn).includes('requestAnimationFrame')) return fn(arg);
      throw new Error(`fake page: ${fn.name || 'anonymous'} not supported`);
    },
    waitForTimeout: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
  const context = { browser: () => ({ version: () => 'fake' }), async addInitScript() {}, pages: () => [page], async newPage() { return page; }, async close() {} };
  const fixture = { name: 'fx', path: join(dir, 'fx.ifc') };
  writeFileSync(fixture.path, 'ISO-10303-21;');
  try {
    const result = await browserSample({ chromium: { launchPersistentContext: async () => context }, executablePath: null, baseUrl: 'http://fake',
      setRoot: () => {}, side: { dist: dir, label: 's', ...side }, fixture, warmOpens, outDir: dir, tag: 't', pass: 'timing', arm });
    return { result, hookCalls };
  } finally {
    if (saved.hook === undefined) delete globalThis.__ifc_lite_boot_settled__; else globalThis.__ifc_lite_boot_settled__ = saved.hook;
    globalThis.__ifc_lite_viewer_store__ = saved.store;
    globalThis.requestAnimationFrame = saved.raf;
    globalThis.__benchLongTasks = saved.tasks;
    rmSync(dir, { recursive: true, force: true });
  }
}
